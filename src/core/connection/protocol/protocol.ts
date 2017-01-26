import Action from './action';
import Message from './message';
/**
 * Provides functions for handling Pusher protocol-specific messages.
 */

/**
 * Decodes a message in a Pusher format.
 *
 * Throws errors when messages are not parse'able.
 *
 * @param  {Object} message
 * @return {Object}
 */
export var decodeMessage = function(message : Message) : Message {
  try {
    var params = JSON.parse(message.data);
    if (typeof params.data === 'string') {
      try {
        params.data = JSON.parse(params.data);
      } catch (e) {
        if (!(e instanceof SyntaxError)) {
          // TODO looks like unreachable code
          // https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/JSON/parse
          throw e;
        }
      }
    }
    return params;
  } catch (e) {
    throw { type: 'MessageParseError', error: e, data: message.data};
  }
};

/**
 * Encodes a message to be sent.
 *
 * @param  {Object} message
 * @return {String}
 */
export var encodeMessage = function(message : Message) : string {
  return JSON.stringify(message);
};

/** Processes a handshake message and returns appropriate actions.
 *
 * Returns an object with an 'action' and other action-specific properties.
 *
 * There are three outcomes when calling this function. First is a successful
 * connection attempt, when pusher:connection_established is received, which
 * results in a 'connected' action with an 'id' property. When passed a
 * pusher:error event, it returns a result with action appropriate to the
 * close code and an error. Otherwise, it raises an exception.
 *
 * @param {String} message
 * @result Object
 */
export var processHandshake = function(message : Message) : Action {
  message = decodeMessage(message);

  if (message.event === "pusher:connection_established") {
    if (!message.data.activity_timeout) {
      throw "No activity timeout specified in handshake";
    }
    return {
      action: "connected",
      id: message.data.socket_id,
      activityTimeout: message.data.activity_timeout * 1000
    };
  } else if (message.event === "pusher:error") {
    // From protocol 6 close codes are sent only once, so this only
    // happens when connection does not support close codes
    return {
      action: this.getCloseAction(message.data),
      error: this.getCloseError(message.data)
    };
  } else {
    throw "Invalid handshake";
  }
};

/**
 * Dispatches the close event and returns an appropriate action name.
 *
 * See:
 * 1. https://developer.mozilla.org/en-US/docs/WebSockets/WebSockets_reference/CloseEvent
 * 2. http://pusher.com/docs/pusher_protocol
 *
 * @param  {CloseEvent} closeEvent
 * @return {String} close action name
 */
export var getCloseAction = function(closeEvent) : string {
  // Pusher-defined ws closeEvent codes are > 4000, see the links in the jsdoc
  if (closeEvent.code === 4000) {
    // retry connection with wss://
    return "ssl_only";
  } else if (closeEvent.code >= 4200 && closeEvent.code < 4300) {
    // connection closed by Pusher, client may reconnect immediately
    return "retry";
  } else {
    // default to retry with backoff
    return "backoff";
  }
};

/**
 * Returns an error or null basing on the close event.
 *
 * Null is returned when connection was closed cleanly. Otherwise, an object
 * with error details is returned.
 *
 * @param  {CloseEvent} closeEvent
 * @return {Object} error object
 */
export var getCloseError = function(closeEvent) : any {
  if (closeEvent.code !== 1000 && closeEvent.code !== 1001) {
    return {
      type: 'PusherError',
      data: {
        code: closeEvent.code,
        message: closeEvent.reason || closeEvent.message
      }
    };
  } else {
    return null;
  }
};
