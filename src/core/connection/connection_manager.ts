import {default as EventsDispatcher} from '../events/dispatcher';
import {OneOffTimer as Timer} from '../utils/timers';
import Logger from '../logger';
import HandshakePayload from './handshake/handshake_payload';
import Connection from "./connection";
import Strategy from "../strategies/strategy";
import StrategyRunner from "../strategies/strategy_runner";
import * as Collections from "../utils/collections";
import Timeline from '../timeline/timeline';
import ConnectionManagerOptions from './connection_manager_options';
import Runtime from 'runtime';
import {ErrorCallbacks, HandshakeCallbacks, ConnectionCallbacks} from './callbacks';
import Pusher from "../pusher";

/** Manages connection to Pusher.
 *
 * Uses a strategy (currently only default), timers and network availability
 * info to establish a connection and export its state. In case of failures,
 * manages reconnection attempts.
 *
 * Exports state changes as following events:
 * - "state_change", { previous: p, current: state }
 * - state
 *
 * States:
 * - initialized - initial state, never transitioned to
 * - connecting - connection is being established
 * - connected - connection has been fully established
 * - disconnected - on requested disconnection
 * - unavailable - after connection timeout or when there's no network
 * - failed - when the connection strategy is not supported
 *
 * Options:
 * - unavailableTimeout - time to transition to unavailable state
 * - activityTimeout - time after which ping message should be sent
 * - pongTimeout - time for Pusher to respond with pong before reconnecting
 *
 * @param {String} key application key
 * @param {Object} options
 */
export default class ConnectionManager extends EventsDispatcher {
  key : string;
  options: ConnectionManagerOptions;
  state: string;
  connection: Connection;
  encrypted: boolean;
  timeline: Timeline;
  socket_id: string;
  unavailableTimer: Timer;
  activityTimer: Timer;
  retryTimer: Timer;
  activityTimeout: number;
  strategy: Strategy;
  runner: StrategyRunner;
  errorCallbacks: ErrorCallbacks;
  handshakeCallbacks: HandshakeCallbacks;
  connectionCallbacks: ConnectionCallbacks;

  constructor(key : string, options : any) {
    super();
    this.key = key;
    this.options = options || {};
    this.state = "initialized";
    this.connection = null;
    this.encrypted = !!options.encrypted;
    this.timeline = this.options.timeline;

    this.connectionCallbacks = this.buildConnectionCallbacks();
    this.errorCallbacks = this.buildErrorCallbacks();
    this.handshakeCallbacks = this.buildHandshakeCallbacks(this.errorCallbacks);

    var Network = Runtime.getNetwork();

    Network.bind("online", ()=> {
      this.timeline.info({ netinfo: "online" });
      if (this.state === "connecting" || this.state === "unavailable") {
        Pusher.log('connection manager - network came online - retrying immediately');
        this.retryIn(0);
      }
    });
    Network.bind("offline", ()=> {
      this.timeline.info({ netinfo: "offline" });
      if (this.connection) {
        Pusher.log('connection manager - network went offline - sending activity check');
        this.sendActivityCheck();
      }
    });

    Pusher.log('connection manager - ctor - updating strategy');
    this.updateStrategy();
  }

  /** Establishes a connection to Pusher.
   *
   * Does nothing when connection is already established. See top-level doc
   * to find events emitted on connection attempts.
   */
  connect() {
    if (this.connection || this.runner) {
      return;
    }
    if (!this.strategy.isSupported()) {
      Pusher.log('connection manager - connect - updating state to failed - strategy not supported');
      this.updateState("failed");
      return;
    }
    Pusher.log('connection manager - connect - updating state to connecting');
    this.updateState("connecting");
    this.startConnecting();
    this.setUnavailableTimer();
  };

  /** Sends raw data.
   *
   * @param {String} data
   */
  send(data) {
    if (this.connection) {
      return this.connection.send(data);
    } else {
      return false;
    }
  };

  /** Sends an event.
   *
   * @param {String} name
   * @param {String} data
   * @param {String} [channel]
   * @returns {Boolean} whether message was sent or not
   */
  send_event(name : string, data : any, channel?: string) {
    if (this.connection) {
      return this.connection.send_event(name, data, channel);
    } else {
      return false;
    }
  };

  /** Closes the connection. */
  disconnect() {
    this.disconnectInternally();
    Pusher.log('connection manager - disconnect - updating state to disconnected');
    this.updateState("disconnected");
  };

  isEncrypted() {
    return this.encrypted;
  };

  private startConnecting() {
    var callback = (error, handshake)=> {
      if (error) {
        this.runner = this.strategy.connect(0, callback);
      } else {
        if (handshake.action === "error") {
          this.emit("error", { type: "HandshakeError", error: handshake.error });
          this.timeline.error({ handshakeError: handshake.error });
        } else {
          this.abortConnecting(); // we don't support switching connections yet
          this.handshakeCallbacks[handshake.action](handshake);
        }
      }
    };
    this.runner = this.strategy.connect(0, callback);
  };

  private abortConnecting() {
    if (this.runner) {
      this.runner.abort();
      this.runner = null;
    }
  };

  private disconnectInternally() {
    this.abortConnecting();
    this.clearRetryTimer();
    this.clearUnavailableTimer();
    if (this.connection) {
      var connection = this.abandonConnection();
      connection.close();
    }
  };

  private updateStrategy() {
    this.strategy = this.options.getStrategy({
      key: this.key,
      timeline: this.timeline,
      encrypted: this.encrypted
    });
  };

  private retryIn(delay) {
    this.timeline.info({ action: "retry", delay: delay });
    if (delay > 0) {
      this.emit("connecting_in", Math.round(delay / 1000));
    }
    this.retryTimer = new Timer(delay || 0, ()=> {
      this.disconnectInternally();
      this.connect();
    });
  };

  private clearRetryTimer() {
    if (this.retryTimer) {
      this.retryTimer.ensureAborted();
      this.retryTimer = null;
    }
  };

  private setUnavailableTimer() {
    this.unavailableTimer = new Timer(
      this.options.unavailableTimeout,
      ()=> {
        Pusher.log('connection manager - connect - updating state to failed - strategy not supported');
        this.updateState("unavailable");
      }
    );
  };

  private clearUnavailableTimer() {
    if (this.unavailableTimer) {
      this.unavailableTimer.ensureAborted();
    }
  };

  private sendActivityCheck() {
    this.stopActivityCheck();
    this.connection.ping();
    // wait for pong response
    this.activityTimer = new Timer(
      this.options.pongTimeout,
      ()=> {
        this.timeline.error({ pong_timed_out: this.options.pongTimeout });
        Pusher.log('connection manager - activity timer - retrying immediately');
        this.retryIn(0);
      }
    );
  };

  private resetActivityCheck() {
    this.stopActivityCheck();
    // send ping after inactivity
    if (!this.connection.handlesActivityChecks()) {
      this.activityTimer = new Timer(this.activityTimeout, ()=> {
        Pusher.log('connection manager - activity timer - sending activity check');
        this.sendActivityCheck();
      });
    }
  };

  private stopActivityCheck() {
    if (this.activityTimer) {
      this.activityTimer.ensureAborted();
    }
  };

  private buildConnectionCallbacks() : ConnectionCallbacks {
    return {
      message: (message)=> {
        // includes pong messages from server
        Pusher.log('connection manager - connection callback - message - resetting activity check');
        this.resetActivityCheck();
        this.emit('message', message);
      },
      ping: ()=> {
        this.send_event('pusher:pong', {});
      },
      activity: ()=> {
        Pusher.log('connection manager - connection callback - activity - resetting activity check');
        this.resetActivityCheck();
      },
      error: (error)=> {
        // just emit error to user - socket will already be closed by browser
        Pusher.log('connection manager - connection callback - error');
        this.emit("error", { type: "WebSocketError", error: error });
      },
      closed: ()=> {
        Pusher.log('connection manager - connection callback - closed');
        this.abandonConnection();
        if (this.shouldRetry()) {
          Pusher.log('connection manager - connection callback - closed - retrying in 1 second');
          this.retryIn(1000);
        }
      }
    };
  };

  private buildHandshakeCallbacks(errorCallbacks : ErrorCallbacks) : HandshakeCallbacks {
    return Collections.extend<HandshakeCallbacks>({}, errorCallbacks, {
      connected: (handshake : HandshakePayload)=> {
        this.activityTimeout = Math.min(
          this.options.activityTimeout,
          handshake.activityTimeout,
          handshake.connection.activityTimeout || Infinity
        );
        this.clearUnavailableTimer();
        this.setConnection(handshake.connection);
        this.socket_id = this.connection.id;
        Pusher.log('connection manager - handshake callback - updating state to connected');
        this.updateState("connected", { socket_id: this.socket_id });
      }
    });
  };

  private buildErrorCallbacks() : ErrorCallbacks {
    let withErrorEmitted = (callback)=> {
      return (result)=> {
        if (result.error) {
          this.emit("error", { type: "WebSocketError", error: result.error });
        }
        callback(result);
      };
    }

    return {
      ssl_only: withErrorEmitted(()=> {
        this.encrypted = true;
        Pusher.log('connection manager - error callback - ssl only - updating strategy');
        this.updateStrategy();
        Pusher.log('connection manager - error callback - ssl only - retrying immediately');
        this.retryIn(0);
      }),
      refused: withErrorEmitted(()=> {
        Pusher.log('connection manager - error callback - refused - disconnecting');
        this.disconnect();
      }),
      backoff: withErrorEmitted(()=> {
        Pusher.log('connection manager - error callback - backoff - retrying in 1 second');
        this.retryIn(1000);
      }),
      retry: withErrorEmitted(()=> {
        Pusher.log('connection manager - error callback - retry - retrying immediately');
        this.retryIn(0);
      })
    };
  };

  private setConnection(connection) {
    this.connection = connection;
    for (var event in this.connectionCallbacks) {
      this.connection.bind(event, this.connectionCallbacks[event]);
    }
    this.resetActivityCheck();
  };

  private abandonConnection() {
    Pusher.log('connection manager - abandoning connection');
    if (!this.connection) {
      return;
    }
    this.stopActivityCheck();
    for (var event in this.connectionCallbacks) {
      this.connection.unbind(event, this.connectionCallbacks[event]);
    }
    var connection = this.connection;
    this.connection = null;
    return connection;
  }

  private updateState(newState : string, data?: any) {
    var previousState = this.state;
    this.state = newState;
    if (previousState !== newState) {
      var newStateDescription = newState;
      if (newStateDescription === "connected") {
        newStateDescription += " with new socket ID " + data.socket_id;
      }
      Logger.debug('State changed', previousState + ' -> ' + newStateDescription);
      this.timeline.info({ state: newState, params: data });
      this.emit('state_change', { previous: previousState, current: newState });
      this.emit(newState, data);
    }
  }

  private shouldRetry() : boolean {
    return this.state === "connecting" || this.state === "connected";
  }

}
