"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const Utils_1 = require("./Utils");
const Model_1 = require("./Model");
const Packet_1 = require("./Packet");
const RefinedEventEmitter_1 = require("./RefinedEventEmitter");
const _ = require("lodash");
const assert = require("assert");
const cheerio = require("cheerio");
const constants = require("./Constants");
const moment = require("moment");
const net = require("net");
const path = require("path");
const request = require("request-promise-native");
const colors = require('colors');
const WebSocket = require("ws");
/**
 * Connection state of the client
 * @access private
 */
exports.ClientState = {
    /** Not currently connected to MFC and not trying to connect */
    IDLE: "IDLE",
    /** Actively trying to connect to MFC but not currently connected */
    PENDING: "PENDING",
    /** Currently connected to MFC */
    ACTIVE: "ACTIVE",
};
/**
 * Creates and maintains a connection to MFC chat servers
 *
 * Client instances are [NodeJS EventEmitters](https://nodejs.org/api/all.html#events_class_eventemitter)
 * and will emit an event every time a Packet is received from the server. The
 * event will be named after the FCType of the Packet. See FCTYPE in
 * ./src/main/Constants.ts for the complete list of possible events.
 *
 * Listening for Client events is an advanced feature and requires some
 * knowledge of MFC's chat server protocol, which will not be documented here.
 * Where possible, listen for events on [Model](#Model) instead.
 */
class Client extends RefinedEventEmitter_1.RefinedEventEmitter {
    /**
     * Client constructor
     * @param [username] Either "guest" or a real MFC member account name, default is "guest"
     * @param [password] Either "guest" or the account's password.
     *
     * This can be either the real password or the password hash as MFCAuto has always taken
     * historically. Client will attempt to auto-detect which type of password you have specified.
     *
     * If your real password looks like a hashed password (exactly 32 alphanumeric characters
     * with no spaces or special characters), it will be incorrectly detected as a hashed
     * password. In which case, you can override the auto-detection of password type and
     * force Client to treat it as the real password by specifying `{ forceUnhashedPassword: true }`
     * as part of the constructor options.
     *
     * If you wish to use the hashed password, you can discover it by checking your browser
     * cookies after logging in via your browser.  In Firefox, go to Options->Privacy
     * and then "Show Cookies..." and search for "myfreecams".  You will see one
     * cookie named "passcode". Select it and copy the value listed as "Content".
     * It will be a long string of lower case letters that looks like gibberish.
     * @param [options] A ClientOptions object detailing several optional Client settings
     * like whether to use WebSockets or traditional TCP sockets and whether to connect
     * to MyFreeCams.com or CamYou.com
     * @example
     * const mfc = require("MFCAuto");
     * const guestMFCClient = new mfc.Client();
     * const premiumMFCClient = new mfc.Client(premiumUsername, premiumPasswordHash);
     * const guestMFCFlashClient = new mfc.Client("guest", "guest", {useWebSockets: false});
     * const guestCamYouClient = new mfc.Client("guest", "guest", {camYou: true});
     * const guestCamYouFlashClient = new mfc.Client("guest", "guest", {useWebSockets: false, camYou: true});
     */
    constructor(username = "guest", password = "guest", options = {}) {
        super();
        this._tokens = 0;
        this._choseToLogIn = false;
        this._completedModels = false;
        this._completedTags = false;
        this._shareHasLoggedIn = false;
        this._roomHelperStatus = new Map();
        this._availableClubShows = new Set();
        const defaultOptions = {
            useWebSockets: true,
            camYou: false,
            useCachedServerConfig: false,
            silenceTimeout: 90000,
            stateSilenceTimeout: 120000,
            loginTimeout: 30000,
            modernLogin: false,
            preserveHtml: false,
            forceUnhashedPassword: false,
        };
        // v4.1.0 supported a third constructor parameter that was a boolean controlling whether to use
        // WebSockets (true) or not (false, the default). For backward compat reasons, we'll still handle
        // that case gracefully. New consumers should move to the options bag syntax.
        if (typeof options === "boolean") {
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, `WARNING: Client useWebSockets as a boolean third constructor parameter is being deprecated, please see the release notes for v4.2.0 for the current way to use a websocket server connection`);
            options = { useWebSockets: options };
        }
        this._options = Object.assign({}, defaultOptions, options);
        this._baseUrl = this._options.camYou ? "camyou.com" : "myfreecams.com";
        this._shareUrl = constants.SHARE_URL;
        this.username = username;
        this.password = password;
        this.sessionId = 0;
        this._streamBuffer = Buffer.alloc(0);
        this._streamWebSocketBuffer = "";
        this._streamPosition = 0;
        this._manualDisconnect = false;
        this._state = exports.ClientState.IDLE;
        Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] Constructed, State: ${this._state}`);
    }
    /**
     * Current server connection state:
     * - IDLE: Not currently connected to MFC and not trying to connect
     * - PENDING: Actively trying to connect to MFC but not currently connected
     * - ACTIVE: Currently connected to MFC
     *
     * If this client is PENDING and you wish to wait for it to enter ACTIVE,
     * use [client.ensureConnected](#clientensureconnectedtimeout).
     */
    get state() {
        return this._state;
    }
    /**
     * How long the current client has been connected to a server
     * in milliseconds. Or 0 if this client is not currently connected
     */
    get uptime() {
        if (this._state === exports.ClientState.ACTIVE
            && this._currentConnectionStartTime) {
            return Date.now() - this._currentConnectionStartTime;
        }
        else {
            return 0;
        }
    }
    /**
     * Returns headers required to authenticate an HTTP request to
     * MFC's web servers.
     * @deprecated
     */
    get httpHeaders() {
        Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, `WARNING: Client.httpHeaders has been deprecated. Please switch to Client.getHttpHeaders(), an asynchronous method that supports usage of raw/unhashed password.`);
        return {
            Cookie: `passcode=${this.password}; username=${this.username}`,
            Origin: `https://www.${this._baseUrl}`,
            Referer: `https://www.${this._baseUrl}/`,
        };
    }
    /**
     * Returns headers required to authenticate an HTTP request to
     * MFC's web servers.
     */
    getHttpHeaders() {
        return __awaiter(this, void 0, void 0, function* () {
            return {
                Cookie: `passcode=${yield this.getPassCode()}; username=${this.username}`,
                Origin: `https://www.${this._baseUrl}`,
                Referer: `https://www.${this._baseUrl}/`,
            };
        });
    }
    /**
     * Tokens available on this account
     */
    get tokens() {
        return this._tokens;
    }
    /**
     * Internal MFCAuto use only
     *
     * Reads data from the socket as quickly as possible and stores it in an internal buffer
     * readData is invoked by the "on data" event of the net.Socket object currently handling
     * the TCP connection to the MFC servers.
     * @param buf New Buffer to read from
     * @access private
     */
    _readData(buf) {
        this._streamBuffer = Buffer.concat([this._streamBuffer, buf]);
        // The new buffer might contain a complete packet, try to read to find out...
        this._readPacket();
    }
    /**
     * Internal MFCAuto use only
     *
     * Reads data from the websocket as quickly as possible and stores it in an internal string
     * readWebSocketData is invoked by the "message" event of the WebSocket object currently
     * handling the connection to the MFC servers.
     * @param buf New string to read from
     * @access private
     */
    _readWebSocketData(buf) {
        this._streamWebSocketBuffer += buf;
        // The new buffer might contain a complete packet, try to read to find out...
        this._readWebSocketPacket();
    }
    /**
     * Internal MFCAuto use only
     *
     * Called with a single, complete, packet. This function processes the packet,
     * handling some special packets like FCTYPE_LOGIN, which gives our user name and
     * session ID when first logging in to mfc. It then calls out to any registered
     * event handlers.
     * @param packet Packet to be processed
     * @access private
     */
    _packetReceived(packet) {
        this._lastPacketTime = Date.now();
        Utils_1.logWithLevelInternal(Utils_1.LogLevel.TRACE, () => packet.toString());
        // Special case some packets to update and maintain internal state
        switch (packet.FCType) {
            case constants.FCTYPE.DETAILS:
            case constants.FCTYPE.ROOMHELPER:
            case constants.FCTYPE.SESSIONSTATE:
            case constants.FCTYPE.ADDFRIEND:
            case constants.FCTYPE.ADDIGNORE:
            case constants.FCTYPE.CMESG:
            case constants.FCTYPE.PMESG:
            case constants.FCTYPE.TXPROFILE:
            case constants.FCTYPE.USERNAMELOOKUP:
            case constants.FCTYPE.MYCAMSTATE:
            case constants.FCTYPE.MYWEBCAM:
            case constants.FCTYPE.JOINCHAN:
                // According to the site code, these packets can all trigger a user state update
                this._lastStatePacketTime = this._lastPacketTime;
                // This case updates our available tokens (yes the logic is insane, but it's lifted right from MFC code...)
                if (packet.FCType === constants.FCTYPE.DETAILS && packet.nTo === this.sessionId) {
                    this._tokens = (packet.nArg1 > 2147483647) ? ((4294967297 - packet.nArg1) * -1) : packet.nArg1;
                }
                // And these specific cases don't update state...
                if ((packet.FCType === constants.FCTYPE.DETAILS && packet.nFrom === constants.FCTYPE.TOKENINC) ||
                    // 100 here is taken directly from MFC's top.js and has no additional
                    // explanation. My best guess is that it is intended to reference the
                    // constant: USER.ID_START. But since I'm not certain, I'll leave this
                    // "magic" number here.
                    (packet.FCType === constants.FCTYPE.ROOMHELPER && packet.nArg2 < 100) ||
                    (packet.FCType === constants.FCTYPE.JOINCHAN && packet.nArg2 === constants.FCCHAN.PART)) {
                    break;
                }
                if (packet.FCType === constants.FCTYPE.ROOMHELPER) {
                    if (packet.nArg2 >= 100 || packet.nArg2 === constants.FCRESPONSE.SUCCESS) {
                        this._roomHelperStatus.set(packet.nArg1, true);
                    }
                    if (packet.nArg2 === constants.FCRESPONSE.SUSPEND) {
                        this._roomHelperStatus.set(packet.nArg1, false);
                    }
                }
                // Ok, we're good, merge if there's anything to merge
                if (packet.sMessage !== undefined) {
                    const msg = packet.sMessage;
                    const lv = msg.lv;
                    const sid = msg.sid;
                    let uid = msg.uid;
                    if (uid === 0 && sid > 0) {
                        uid = sid;
                    }
                    if (uid === undefined && packet.aboutModel !== undefined) {
                        uid = packet.aboutModel.uid;
                    }
                    // Only merge models (when we can tell). Unfortunately not every SESSIONSTATE
                    // packet has a user level property. So this is no worse than we had been doing
                    // before in terms of merging non-models...
                    if (uid !== undefined && uid !== -1 && (lv === undefined || lv === constants.FCLEVEL.MODEL)) {
                        // If we know this is a model, get her instance and create it
                        // if it does not exist.  Otherwise, don't create an instance
                        // for someone that might not be a model.
                        const possibleModel = Model_1.Model.getModel(uid, lv === constants.FCLEVEL.MODEL);
                        if (possibleModel !== undefined) {
                            possibleModel.merge(msg);
                        }
                    }
                }
                break;
            case constants.FCTYPE.TAGS:
                const tagPayload = packet.sMessage;
                if (typeof tagPayload === "object") {
                    for (const key in tagPayload) {
                        if (tagPayload.hasOwnProperty(key)) {
                            const possibleModel = Model_1.Model.getModel(key);
                            if (possibleModel !== undefined) {
                                possibleModel.mergeTags(tagPayload[key]);
                            }
                        }
                    }
                }
                break;
            case constants.FCTYPE.BOOKMARKS:
                const bmMsg = packet.sMessage;
                if (Array.isArray(bmMsg.bookmarks)) {
                    bmMsg.bookmarks.forEach((b) => {
                        const possibleModel = Model_1.Model.getModel(b.uid);
                        if (possibleModel !== undefined) {
                            possibleModel.merge(b);
                        }
                    });
                }
                break;
            case constants.FCTYPE.EXTDATA:
                if (packet.nTo === this.sessionId && packet.nArg2 === constants.FCWOPT.REDIS_JSON) {
                    this._handleExtData(packet.sMessage).catch((reason) => {
                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: _packetReceived caught rejection from _handleExtData: ${reason}`);
                    });
                }
                break;
            case constants.FCTYPE.METRICS:
                // For METRICS, nTO is an FCTYPE indicating the type of data that's
                // starting or ending, nArg1 is the count of data received so far, and nArg2
                // is the total count of data, so when nArg1 === nArg2, we're done for that data
                // Note that after MFC server updates on 2017-04-18, Metrics packets are rarely,
                // or possibly never, sent
                break;
            case constants.FCTYPE.MANAGELIST:
                if (packet.nArg2 > 0 && packet.sMessage !== undefined && packet.sMessage.rdata !== undefined) {
                    const rdata = this.processListData(packet.sMessage.rdata);
                    const nType = packet.nArg2;
                    switch (nType) {
                        case constants.FCL.ROOMMATES:
                            if (Array.isArray(rdata)) {
                                rdata.forEach((viewer) => {
                                    if (viewer !== undefined) {
                                        const possibleModel = Model_1.Model.getModel(viewer.uid, viewer.lv === constants.FCLEVEL.MODEL);
                                        if (possibleModel !== undefined) {
                                            possibleModel.merge(viewer);
                                        }
                                    }
                                });
                            }
                            break;
                        case constants.FCL.CAMS:
                            if (Array.isArray(rdata)) {
                                rdata.forEach((model) => {
                                    if (model !== undefined) {
                                        const possibleModel = Model_1.Model.getModel(model.uid, model.lv === constants.FCLEVEL.MODEL);
                                        if (possibleModel !== undefined) {
                                            possibleModel.merge(model);
                                        }
                                    }
                                });
                                if (!this._completedModels) {
                                    this._completedModels = true;
                                    if (this._completedTags) {
                                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, `[CLIENT] emitting: CLIENT_MODELSLOADED`);
                                        this.emit("CLIENT_MODELSLOADED");
                                    }
                                }
                            }
                            break;
                        case constants.FCL.FRIENDS:
                            if (Array.isArray(rdata)) {
                                rdata.forEach((model) => {
                                    if (model !== undefined) {
                                        const possibleModel = Model_1.Model.getModel(model.uid, model.lv === constants.FCLEVEL.MODEL);
                                        if (possibleModel !== undefined) {
                                            possibleModel.merge(model);
                                        }
                                    }
                                });
                            }
                            break;
                        case constants.FCL.IGNORES:
                            if (Array.isArray(rdata)) {
                                rdata.forEach((user) => {
                                    if (user !== undefined) {
                                        const possibleModel = Model_1.Model.getModel(user.uid, user.lv === constants.FCLEVEL.MODEL);
                                        if (possibleModel !== undefined) {
                                            possibleModel.merge(user);
                                        }
                                    }
                                });
                            }
                            break;
                        case constants.FCL.TAGS:
                            const tagPayload2 = rdata;
                            if (tagPayload2 !== undefined) {
                                for (const key in tagPayload2) {
                                    if (tagPayload2.hasOwnProperty(key)) {
                                        const possibleModel = Model_1.Model.getModel(key);
                                        if (possibleModel !== undefined) {
                                            possibleModel.mergeTags(tagPayload2[key]);
                                        }
                                    }
                                }
                                if (!this._completedTags) {
                                    this._completedTags = true;
                                    if (this._completedModels) {
                                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, `[CLIENT] emitting: CLIENT_MODELSLOADED`);
                                        this.emit("CLIENT_MODELSLOADED");
                                    }
                                }
                            }
                            break;
                        case constants.FCL.SHARE_CLUBS:
                            // @TODO
                            break;
                        case constants.FCL.SHARE_CLUBMEMBERSHIPS:
                            // @TODO
                            break;
                        case constants.FCL.SHARE_CLUBSHOWS:
                            if (Array.isArray(rdata)) {
                                rdata.forEach((message) => {
                                    this._packetReceived(new Packet_1.Packet(constants.FCTYPE.CLUBSHOW, 
                                    // tslint:disable-next-line:no-any
                                    message.model, packet.nTo, packet.nArg1, packet.nArg2, 0, message));
                                });
                            }
                            break;
                        default:
                            Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: _packetReceived unhandled list type on MANAGELIST packet: ${nType}`);
                    }
                }
                break;
            case constants.FCTYPE.ROOMDATA:
                if (packet.nArg1 === 0 && packet.nArg2 === 0) {
                    if (Array.isArray(packet.sMessage)) {
                        const sizeOfModelSegment = 2;
                        for (let i = 0; i < packet.sMessage.length; i = i + sizeOfModelSegment) {
                            const possibleModel = Model_1.Model.getModel(packet.sMessage[i]);
                            if (possibleModel !== undefined) {
                                possibleModel.merge({ "sid": possibleModel.bestSessionId, "m": { "rc": packet.sMessage[i + 1] } });
                            }
                        }
                    }
                    else if (typeof (packet.sMessage) === "object") {
                        for (const key in packet.sMessage) {
                            if (packet.sMessage.hasOwnProperty(key)) {
                                const rdmsg = packet.sMessage;
                                const possibleModel = Model_1.Model.getModel(key);
                                if (possibleModel !== undefined) {
                                    possibleModel.merge({ "sid": possibleModel.bestSessionId, "m": { "rc": rdmsg[key] } });
                                }
                            }
                        }
                    }
                }
                break;
            case constants.FCTYPE.TKX:
                const auth = packet.sMessage;
                if (auth && auth.cxid && auth.tkx && auth.ctxenc) {
                    this.stream_cxid = auth.cxid;
                    this.stream_password = auth.tkx;
                    const pwParts = auth.ctxenc.split("/");
                    this.stream_vidctx = pwParts.length > 1 ? pwParts[1] : auth.ctxenc;
                }
                break;
            case constants.FCTYPE.TOKENINC:
                if (packet.sMessage === undefined) {
                    this._tokens = packet.nArg1;
                }
                break;
            case constants.FCTYPE.CLUBSHOW:
                const showDetails = packet.sMessage;
                if (showDetails.op === constants.FCCHAN.WELCOME && showDetails.tksid !== undefined) {
                    this._availableClubShows.add(showDetails.model);
                }
                else {
                    this._availableClubShows.delete(showDetails.model);
                }
                break;
            default:
                break;
        }
        // Fire this packet's event for any listeners
        this.emit(constants.FCTYPE[packet.FCType], packet);
        this.emit(constants.FCTYPE[constants.FCTYPE.ANY], packet);
    }
    /**
     * Internal MFCAuto use only
     *
     * Parses the incoming MFC stream buffer from a socket connection. For each
     * complete individual packet parsed, it will call packetReceived. Because
     * of the single-threaded async nature of node.js, there will often be partial
     * packets and this needs to handle that gracefully, only calling packetReceived
     * once we've parsed out a complete response.
     * @access private
     */
    _readPacket() {
        let pos = this._streamPosition;
        const intParams = [];
        let strParam;
        try {
            // Each incoming packet is initially tagged with 7 int32 values, they look like this:
            //  0 = "Magic" value that is *always* -2027771214
            //  1 = "FCType" that identifies the type of packet this is (FCType being a MyFreeCams defined thing)
            //  2 = nFrom
            //  3 = nTo
            //  4 = nArg1
            //  5 = nArg2
            //  6 = sPayload, the size of the payload
            //  7 = sMessage, the actual payload.  This is not an int but is the actual buffer
            // Any read here could throw a RangeError exception for reading beyond the end of the buffer.  In theory we could handle this
            // better by checking the length before each read, but that would be a bit ugly.  Instead we handle the RangeErrors and just
            // try to read again the next time the buffer grows and we have more data
            // Parse out the first 7 integer parameters (Magic, FCType, nFrom, nTo, nArg1, nArg2, sPayload)
            const countOfIntParams = 7;
            const sizeOfInt32 = 4;
            for (let i = 0; i < countOfIntParams; i++) {
                intParams.push(this._streamBuffer.readInt32BE(pos));
                pos += sizeOfInt32;
            }
            const [magic, fcType, nFrom, nTo, nArg1, nArg2, sPayload] = intParams;
            // If the first integer is MAGIC, we have a valid packet
            if (magic === constants.MAGIC) {
                // If there is a JSON payload to this packet
                if (sPayload > 0) {
                    // If we don't have the complete payload in the buffer already, bail out and retry after we get more data from the network
                    if (pos + sPayload > this._streamBuffer.length) {
                        throw new RangeError(); // This is needed because streamBuffer.toString will not throw a rangeerror when the last param is out of the end of the buffer
                    }
                    // We have the full packet, store it and move our buffer pointer to the next packet
                    strParam = this._streamBuffer.toString("utf8", pos, pos + sPayload);
                    pos = pos + sPayload;
                }
            }
            else {
                // Magic value did not match?  In that case, all bets are off.  We no longer understand the MFC stream and cannot recover...
                // This is usually caused by a mis-alignment error due to incorrect buffer management (bugs in this code or the code that writes the buffer from the network)
                this._disconnected(`>>> Invalid packet received! - ${magic} Length == ${this._streamBuffer.length}`);
                return;
            }
            // At this point we have the full packet in the intParams and strParam values, but intParams is an unstructured array
            // Let's clean it up before we delegate to this.packetReceived.  (Leaving off the magic int, because it MUST be there always
            // and doesn't add anything to the understanding)
            let sMessage;
            if (strParam !== undefined && strParam !== "") {
                try {
                    sMessage = JSON.parse(strParam);
                }
                catch (e) {
                    sMessage = strParam;
                }
            }
            this._packetReceived(new Packet_1.Packet(fcType, nFrom, nTo, nArg1, nArg2, sPayload, sMessage));
            // If there's more to read, keep reading (which would be the case if the network sent >1 complete packet in a single transmission)
            if (pos < this._streamBuffer.length) {
                this._streamPosition = pos;
                this._readPacket();
            }
            else {
                // We read the full buffer, clear the buffer cache so that we can
                // read cleanly from the beginning next time (and save memory)
                this._streamBuffer = Buffer.alloc(0);
                this._streamPosition = 0;
            }
        }
        catch (e) {
            // RangeErrors are expected because sometimes the buffer isn't complete.  Other errors are not...
            if (!(e instanceof RangeError)) {
                this._disconnected(`Unexpected error while reading socket stream: ${e}`);
            }
            else {
                //  this.log("Expected exception (?): " + e);
            }
        }
    }
    /**
     * Internal MFCAuto use only
     *
     * Parses the incoming MFC data string from a WebSocket connection. For each
     * complete individual packet parsed, it will call packetReceived.
     * @access private
     */
    _readWebSocketPacket() {
        const sizeTagLength = 6;
        const minimumPacketLength = sizeTagLength + 9; // tag chars + 5 possibly single digit numbers + 4 spaces
        while (this._streamWebSocketBuffer.length >= minimumPacketLength) {
            // Occasionally there is noise in the WebSocket buffer
            // it really should start with 7-8 digits followed by a
            // space. Where the first 6 digits are the size of the
            // total message and the last digits of that first 7-8
            // are the FCType of the first Packet in the buffer
            // We'll clean it up by shifting the buffer until we
            // find that pattern
            while (!Client.webSocketNoiseFilter.test(this._streamWebSocketBuffer) && this._streamWebSocketBuffer.length > (minimumPacketLength * 10)) {
                // If this happens too often it likely represents a bug
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: _readWebSocketPacket handling noise: '${this._streamWebSocketBuffer.slice(0, 30)}...'`);
                this._streamWebSocketBuffer = this._streamWebSocketBuffer.slice(1);
            }
            if (this._streamWebSocketBuffer.length < minimumPacketLength) {
                return;
            }
            const messageLength = parseInt(this._streamWebSocketBuffer.slice(0, sizeTagLength), 10);
            if (isNaN(messageLength)) {
                // If this packet is invalid we can possibly recover by continuing to shift
                // the buffer to the next packet. If that doesn't ever line up and work
                // we should still be able to recover eventually through silence timeouts.
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: _readWebSocketPacket received invalid packet: '${this._streamWebSocketBuffer}'`);
                return;
            }
            if (this._streamWebSocketBuffer.length < messageLength) {
                return;
            }
            this._streamWebSocketBuffer = this._streamWebSocketBuffer.slice(sizeTagLength);
            let currentMessage = this._streamWebSocketBuffer.slice(0, messageLength);
            this._streamWebSocketBuffer = this._streamWebSocketBuffer.slice(messageLength);
            const countOfIntParams = 5;
            const intParamsLength = currentMessage.split(" ", countOfIntParams).reduce((p, c) => p + c.length, 0) + countOfIntParams;
            const intParams = currentMessage.split(" ", countOfIntParams).map(s => parseInt(s, 10));
            const [FCType, nFrom, nTo, nArg1, nArg2] = intParams;
            currentMessage = currentMessage.slice(intParamsLength);
            let sMessage;
            if (currentMessage.length > 0) {
                try {
                    sMessage = JSON.parse(decodeURIComponent(currentMessage));
                }
                catch (e) {
                    // Guess it wasn't a JSON blob. OK, just use it raw.
                    sMessage = currentMessage;
                }
            }
            this._packetReceived(new Packet_1.Packet(FCType, nFrom, nTo, nArg1, nArg2, currentMessage.length, currentMessage.length === 0 ? undefined : sMessage));
        }
    }
    /**
     * Internal MFCAuto use only
     *
     * Incoming FCTYPE.EXTDATA messages are signals to request additional
     * data from an external REST API. This helper function handles that task
     * and invokes packetReceived with the results of the REST call
     * @param extData An ExtDataMessage
     * @returns A promise that resolves when data has been retrieves from
     * the web API and packetReceived has completed
     * @access private
     */
    _handleExtData(extData) {
        return __awaiter(this, void 0, void 0, function* () {
            if (extData !== undefined && extData.respkey !== undefined) {
                const url = `http://www.${this._baseUrl}/php/FcwExtResp.php?respkey=${extData.respkey}&type=${extData.type}&opts=${extData.opts}&serv=${extData.serv}`;
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.TRACE, () => `[CLIENT] _handleExtData: ${JSON.stringify(extData)} - '${url}'`);
                const contentLogLimit = 80;
                let contents = "";
                try {
                    contents = (yield request(url).promise());
                    Utils_1.logWithLevelInternal(Utils_1.LogLevel.TRACE, () => `[CLIENT] _handleExtData response: ${JSON.stringify(extData)} - '${url}'\n\t${contents.slice(0, contentLogLimit)}...`);
                    // tslint:disable-next-line:no-unsafe-any
                    const p = new Packet_1.Packet(extData.msg.type, extData.msg.from, extData.msg.to, extData.msg.arg1, extData.msg.arg2, extData.msglen, JSON.parse(contents));
                    this._packetReceived(p);
                }
                catch (e) {
                    Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: _handleExtData error: ${e} - ${JSON.stringify(extData)} - '${url}'\n\t${contents.slice(0, contentLogLimit)}...`);
                }
            }
        });
    }
    /**
     * Processes the .rdata component of an FCTYPE.MANAGELIST server packet
     *
     * MANAGELIST packets are used by MFC for bulk dumps of data. For instance,
     * they're used when you first log in to send the initial lists of online
     * models, and when you first join a room to send the initial lists of
     * other members in the room.
     *
     * If an MFCAuto consumer script wants to intercept and interpret details
     * like that, it will need to listen for "MANAGELIST" events emitted from
     * the client instance and process the results using this function.
     *
     * Most of the details are encoded in the .rdata element of the ManageListMessage
     * and its format is cumbersome to deal with. This function handles the insanity.
     * @param rdata rdata property off a received ManageListMessage
     * @returns Either a list of Message elements, most common, or an
     * FCTypeTagsResponse, which is an object containing tag information for
     * one or more models.
     * @access private
     */
    processListData(rdata) {
        // Really MFC?  Really??  Ok, commence the insanity...
        if (Array.isArray(rdata) && rdata.length > 0) {
            const result = [];
            const schema = rdata[0];
            const schemaMap = [];
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] _processListData, processing schema: ${JSON.stringify(schema)}`);
            if (Array.isArray(schema)) {
                // Build a map of array index -> property path from the schema
                schema.forEach((prop) => {
                    if (typeof prop === "object") {
                        Object.keys(prop).forEach((key) => {
                            if (Array.isArray(prop[key])) {
                                prop[key].forEach((prop2) => {
                                    schemaMap.push([key, prop2]);
                                });
                            }
                            else {
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `_processListData. N-level deep schemas? ${JSON.stringify(schema)}`);
                            }
                        });
                    }
                    else {
                        schemaMap.push(prop);
                    }
                });
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] _processListData. Calculated schema map: ${JSON.stringify(schemaMap)}`);
                rdata.slice(1).forEach((record) => {
                    if (Array.isArray(record)) {
                        // Now apply the schema
                        const msg = {};
                        for (let i = 0; i < record.length; i++) {
                            if (schemaMap.length > i) {
                                let schemaPath = schemaMap[i];
                                if (Array.isArray(schemaPath)) {
                                    schemaPath = schemaPath.join(".");
                                }
                                _.set(msg, schemaPath, record[i]);
                            }
                            else {
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: _processListData. Not enough elements in schema\n\tSchema: ${JSON.stringify(schema)}\n\tSchemaMap: ${JSON.stringify(schemaMap)}\n\tData: ${JSON.stringify(record)}`);
                            }
                        }
                        result.push(msg);
                    }
                    else {
                        result.push(record);
                    }
                });
            }
            else {
                // tslint:disable-next-line:no-any
                return rdata;
            }
            return result;
        }
        else {
            return rdata;
        }
    }
    /**
     * Encodes raw chat text strings into a format the MFC servers understand
     * @param rawMsg A chat string like `I am happy :mhappy`
     * @returns A promise that resolve with the translated text like
     * `I am happy #~ue,2c9d2da6.gif,mhappy~#`
     * @access private
     */
    encodeRawChat(rawMsg) {
        return __awaiter(this, void 0, void 0, function* () {
            // On MFC, this code is part of the ParseEmoteInput function in
            // https://www.myfreecams.com/_js/mfccore.js, and it is especially convoluted
            // code involving ajax requests back to the server depending on the text you're
            // sending and a giant hashtable of known emotes.
            return new Promise((resolve, reject) => {
                // Pre-filters mostly taken from player.html's SendChat method
                if (rawMsg.match(/^\s*$/) !== null || rawMsg.match(/:/) === null) {
                    resolve(rawMsg);
                    return;
                }
                rawMsg = rawMsg.replace(/`/g, "'");
                rawMsg = rawMsg.replace(/<~/g, "'");
                rawMsg = rawMsg.replace(/~>/g, "'");
                this._ensureEmoteParserIsLoaded()
                    .then(() => this._emoteParser.Process(rawMsg, resolve))
                    .catch((reason) => reject(reason));
            });
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Loads the emote parsing code from the MFC web site directly, if it's not
     * already loaded, and then invokes the given callback.  This is useful because
     * most scripts won't actually need the emote parsing capabilities, so lazy
     * loading it can speed up the common case.
     *
     * We're loading this code from the live site instead of re-coding it ourselves
     * here because of the complexity of the code and the fact that it has changed
     * several times in the past.
     * @returns A promise that resolves when this.emoteParser has been initialized
     * @access private
     */
    _ensureEmoteParserIsLoaded() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._emoteParser === undefined) {
                const obj = yield Utils_1.loadFromWeb(`https://www.${this._baseUrl}/_js/mfccore.js`, (content) => {
                    // Massager....Yes this is vulnerable to site breaks, but then
                    // so is this entire module.
                    // First, pull out only the ParseEmoteInput function
                    const startIndex = content.indexOf("// js_build_core: MfcJs/ParseEmoteInput/ParseEmoteInput.js");
                    const endIndex = content.indexOf("// js_build_core: ", startIndex + 1);
                    assert.ok(startIndex !== -1 && endIndex !== -1 && startIndex < endIndex, "mfccore.js layout has changed, don't know what to do now");
                    content = content.substr(startIndex, endIndex - startIndex);
                    // Then massage the function somewhat and prepend some prerequisites
                    content = `var document = {cookie: '', domain: '${this._baseUrl}', location: { protocol: 'https:' }};
                            var g_hPlatform = {
                                "id": 01,
                                "domain": "${this._baseUrl}",
                                "name": "MyFreeCams",
                                "code": "mfc",
                                "image_url": "https://img.mfcimg.com/",
                                "performer": "model",
                                "Performer": "Model",
                                "avatar_prefix": "avatar",
                            };
                            var XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;
                            function bind(that,f){return f.bind(that);}` + content;
                    content = content.replace(/this.createRequestObject\(\)/g, "new XMLHttpRequest()");
                    content = content.replace(/new MfcImageHost\(\)/g, "{host: function(){return '';}}");
                    content = content.replace(/this\.Reset\(\);/g, "this.Reset();this.oReq = new XMLHttpRequest();");
                    content = content.replace(/MfcClientRes/g, "undefined");
                    return content;
                });
                // tslint:disable-next-line:no-unsafe-any
                this._emoteParser = new obj.ParseEmoteInput();
                this._emoteParser.setUrl(`https://api.${this._baseUrl}/parseEmote`);
            }
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Loads the latest server information from MFC, if it's not already loaded
     * @returns A promise that resolves when this.serverConfig has been initialized
     * @access private
     */
    _ensureServerConfigIsLoaded() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.serverConfig === undefined) {
                if (this._options.useCachedServerConfig) {
                    this.serverConfig = constants.CACHED_SERVERCONFIG;
                }
                else {
                    const mfcConfig = yield request(`https://www.${this._baseUrl}/_js/serverconfig.js?nc=${Math.random()}`).promise();
                    try {
                        this.serverConfig = JSON.parse(mfcConfig);
                    }
                    catch (e) {
                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.ERROR, `Error parsing serverconfig: '${mfcConfig}'`);
                        throw e;
                    }
                }
            }
        });
    }
    /**
     * Sends a command to the MFC chat server. Don't use this unless
     * you really know what you're doing.
     * @param nType FCTYPE of the message
     * @param nTo Number representing the channel or entity the
     * message is for. This is often left as 0.
     * @param nArg1 First argument of the message. Its meaning varies
     * depending on the FCTYPE of the message. Often left as 0.
     * @param nArg2 Second argument of the message. Its meaning
     * varies depending on the FCTYPE of the message. Often left as 0.
     * @param sMsg Payload of the message. Its meaning varies depending
     * on the FCTYPE of the message and is sometimes is stringified JSON.
     * Most often this should remain undefined.
     */
    TxCmd(nType, nTo = 0, nArg1 = 0, nArg2 = 0, sMsg) {
        Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] TxCmd Sending - nType: ${constants.FCTYPE[nType]}, nTo: ${nTo}, nArg1: ${nArg1}, nArg2: ${nArg2}, sMsg:${sMsg}`);
        if (this.state === exports.ClientState.IDLE) {
            throw new Error("Client is not connected. Please call 'connect' before attempting this.");
        }
        if (this.state === exports.ClientState.PENDING && nType !== constants.FCTYPE.LOGIN) {
            throw new Error("Client is trying to connect and cannot send server commands yet. Please ensure the client is active by checking Client.state or Client.ensureConnected before attempting this.");
        }
        if (this._client === undefined) {
            // Should not be possible to hit this condition as our state should be idle
            // or pending whenever _client is undefined. This is only defense-in-depth.
            throw new Error("Client is not ready to process commands, undefined _client");
        }
        if (this._client instanceof net.Socket) {
            const msgLength = (sMsg ? sMsg.length : 0);
            const buf = Buffer.alloc((7 * 4) + msgLength);
            buf.writeInt32BE(constants.MAGIC, 0);
            buf.writeInt32BE(nType, 4);
            buf.writeInt32BE(this.sessionId, 8); // Session id, this is always our nFrom value
            buf.writeInt32BE(nTo, 12);
            buf.writeInt32BE(nArg1, 16);
            buf.writeInt32BE(nArg2, 20);
            buf.writeInt32BE(msgLength, 24);
            if (sMsg) {
                buf.write(sMsg, 28);
            }
            this._client.write(buf);
        }
        else {
            this._client.send(`${nType} ${this.sessionId} ${nTo} ${nArg1} ${nArg2}${sMsg ? " " + sMsg : ""}\n\0`);
        }
        // @TODO - Consider converting TxCmd to return a promise and catching any
        // exceptions in client.send. In those cases, we could call ._disconnected()
        // and wait on the CLIENT_CONNECTED event before trying to send the message
        // again and then only resolve when we finally do send the message (or until
        // manual disconnect() is called)
        //
        // On the other hand, during periods of long disconnect, that could cause a
        // swarm of pending commands that would flood the server when we finally
        // do get a connection, possibly causing MFC to drop and/or block us. So
        // we'd need to handle it gracefully.
    }
    /**
     * Sends a command to the MFC chat server. Don't use this unless
     * you really know what you're doing.
     * @param packet Packet instance encapsulating the command to be sent
     */
    TxPacket(packet) {
        this.TxCmd(packet.FCType, packet.nTo, packet.nArg1, packet.nArg2, JSON.stringify(packet.sMessage));
    }
    /**
     * Takes a number that might be a user id or a room/channel id and converts
     * it to a user id (if necessary)
     * @param id A number that is either a model ID or room/channel ID
     * @returns The model ID corresponding to the given id
     */
    toUserId(id) {
        return id % constants.CHANNEL.ID_START;
    }
    /**
     * Takes a number that might be a user id or a room/channel id and converts
     * it to a user id (if necessary)
     * @param id A number that is either a model ID or room/channel ID
     * @returns The model ID corresponding to the given id
     */
    static toUserId(id) {
        return id % constants.CHANNEL.ID_START;
    }
    /**
     * Takes a number that might be a room/channel id or a user id and
     * converts it to a channel id of the given type, FreeChat by default,
     * if necessary
     * @param id A number that is either a room/channel ID or a model ID
     * @param type The type of channel ID to return (FreeChat/Private/Group/Club). Default is FreeChat.
     */
    toChannelId(id, type = constants.ChannelType.FreeChat) {
        id = this.toUserId(id);
        switch (type) {
            case constants.ChannelType.FreeChat:
                id = id + (this._options.camYou ? constants.CAMCHAN.ID_START : constants.CHANNEL.ID_START);
                break;
            case constants.ChannelType.NonFreeChat:
                id = id + constants.SESSCHAN.ID_START;
                break;
            default:
                throw new Error(`toChannelId doesn't understand this channel type: ${type}`);
        }
        return id;
    }
    /**
     * Takes a room/channel id and returns its type, or "undefined"
     * if the given id was a user id and not a channel id
     * @param channelId A chat channel id
     */
    getChannelType(channelId) {
        if (this.toUserId(channelId) === channelId) {
            return undefined;
        }
        if (this._options.camYou) {
            if (channelId > constants.CAMCHAN.ID_START && channelId < constants.CAMCHAN.ID_END) {
                return constants.ChannelType.FreeChat;
            }
        }
        else {
            if (channelId > constants.CHANNEL.ID_START && channelId < constants.SESSCHAN.ID_START) {
                return constants.ChannelType.FreeChat;
            }
        }
        if (channelId > constants.SESSCHAN.ID_START && channelId < constants.SESSCHAN.ID_END) {
            return constants.ChannelType.NonFreeChat;
        }
        throw new Error(`getChannelType doesn't know how to convert ${channelId} into a valid channel type`);
    }
    /**
     * Internal helper function that checks if the given
     * id is a model id or channel id. If it's a channel
     * id, that channel id is returned unchanged. If it's
     * a model id, her corresponding FreeChat channel id
     * is returned instead.
     * @param id A model or channel id
     */
    _toFreeIfModel(id) {
        if (this.getChannelType(id) === undefined) {
            return this.toChannelId(id, constants.ChannelType.FreeChat);
        }
        else {
            return id;
        }
    }
    /**
     * Internal helper function
     * Finds the right channel to join for a given model
     */
    _negotiateChannelForJoining(cid, mid) {
        const channelType = this.getChannelType(cid);
        if (channelType === undefined) {
            throw new Error(`Invalid channel id`);
        }
        else if (channelType === constants.ChannelType.FreeChat) {
            return cid;
        }
        else {
            const m = Model_1.Model.getModel(mid);
            if (m !== undefined
                && m.bestSession.vs === constants.STATE.Club) {
                if (this._availableClubShows.has(mid)) {
                    return cid;
                }
                else {
                    throw new Error(`No valid memberships for model ${mid}'s club show`);
                }
            }
        }
        return this.toChannelId(mid, constants.ChannelType.FreeChat);
    }
    /**
     * Takes a number that might be a user id or a room id and converts
     * it to a room id (if necessary)
     * @param id A number that is either a model ID or a room/channel ID
     * @param [camYou] True if the ID calculation should be done for
     * CamYou.com. False if the ID calculation should be done for MFC.
     * Default is False
     * @returns The free chat room/channel ID corresponding to the given ID
     */
    static toRoomId(id, camYou = false) {
        const publicRoomId = camYou ? constants.CAMCHAN.ID_START : constants.CHANNEL.ID_START;
        if (id < publicRoomId) {
            id = id + publicRoomId;
        }
        return id;
    }
    /**
     * Send chat to a model's public chat room
     *
     * If the message is one you intend to send more than once,
     * and your message contains emotes, you can save some processing
     * overhead by calling client.encodeRawChat once for the string,
     * caching the result of that call, and passing that string here.
     *
     * Note that you must have previously joined the model's chat room
     * for the message to be sent successfully.
     * @param id Model or room/channel ID to send the chat to
     * @param msg Text to be sent, can contain emotes
     * @returns A promise that resolves after the text has
     * been sent to the server. There is no check on success and
     * the message may fail to be sent if you are muted or ignored
     * by the model
     */
    sendChat(id, msg) {
        return __awaiter(this, void 0, void 0, function* () {
            id = this._toFreeIfModel(id);
            const encodedMsg = yield this.encodeRawChat(msg);
            this.TxCmd(constants.FCTYPE.CMESG, id, 0, 0, encodedMsg);
        });
    }
    /**
     * Send a PM to the given model or member
     *
     * If the message is one you intend to send more than once,
     * and your message contains emotes, you can save some processing
     * overhead by calling client.encodeRawChat once for the string,
     * caching the result of that call, and passing that string here.
     * @param id Model or member ID to send the PM to
     * @param msg Text to be sent, can contain emotes
     * @returns A promise that resolves after the text has
     * been sent to the server. There is no check on success and
     * the message may fail to be sent if you are muted or ignored
     * by the model or member
     */
    sendPM(id, msg) {
        return __awaiter(this, void 0, void 0, function* () {
            const encodedMsg = yield this.encodeRawChat(msg);
            id = this.toUserId(id);
            this.TxCmd(constants.FCTYPE.PMESG, id, 0, 0, encodedMsg);
        });
    }
    /**
     * Sends a tip to the given model
     * @param id Model ID to tip
     * @param amount Token value to tip
     * @param options Options bag to specify various options about the tip
     * @returns A promise that resolves after the tip response is received
     */
    sendTip(id, amount, options) {
        return __awaiter(this, void 0, void 0, function* () {
            const defaultTipOptions = {
                submit_tip: 1,
                api: 1,
                json: 1,
                broadcaster_id: this.toUserId(id),
                tip_value: amount,
                anonymous: 0,
                comment: "",
                public: 1,
                public_comment: 1,
                silent: 0,
                hide_amount: 0,
                usersession: this.sessionId,
                token: this._webApiToken,
                no_cache: Math.random(),
            };
            const finalTipOptions = Object.assign({}, defaultTipOptions, options);
            const tipUrl = `https://www.${this._baseUrl}/php/tip.php`;
            const rawResult = yield request({ method: "POST", url: tipUrl, form: finalTipOptions, headers: yield this.getHttpHeaders() }).promise();
            let result;
            try {
                result = JSON.parse(rawResult);
            }
            catch (e) {
                throw new Error(`Malformed tip response: '${rawResult}'`);
            }
            if (!result.success) {
                throw new Error(result.message);
            }
            else {
                return result.message;
            }
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Logs in to MFCShare with this client's credentials and
     * populates a CookieJar with a variety of auth tokens returned
     * by the server's response.
     */
    _shareLogin() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(this._shareHasLoggedIn && this._passcode_password === this.password)) {
                const currentPassCode = yield this.getPassCode();
                if (currentPassCode === "guest") {
                    throw new Error("This requires a Client created with valid non-guest credentials");
                }
                // Load the front page to initialize the cookie jar
                this._shareCookieJar = request.jar();
                yield request({ url: this._shareUrl, jar: this._shareCookieJar }).promise();
                // Add the our credentials as cookies
                this._shareCookieJar.setCookie(request.cookie(`username=${this.username}`), this._shareUrl);
                this._shareCookieJar.setCookie(request.cookie(`passcode=${currentPassCode}`), this._shareUrl);
                // Get the login url (which will set the authentication tokens as cookies)
                yield request({ url: `${this._shareUrl}/auth/login`, headers: { Host: `share.myfreecams.com`, Referer: this._shareUrl }, jar: this._shareCookieJar }).promise();
                this._shareHasLoggedIn = true;
            }
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Returns the prefix and slug given an MFC Share voucher url or Share thing url
     * @param thingUrl MFC Share voucher url or Share thing url
     * @returns A promise that resolves with an Object with two keys: prefix & slug
     */
    _getSharePrefixSlugFromUrl(thingUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            const shareRe = /^https:\/\/(share\.myfreecams\.com|mfcsha\.re)\/([a-z])\/(.*)$/;
            thingUrl = thingUrl.toLowerCase().trim();
            const match = shareRe.exec(thingUrl);
            if (match === null) {
                throw new Error(`Invalid MFC Share thing url`);
            }
            yield this._shareLogin();
            let prefix = match[2];
            let slug = match[3];
            if (prefix === "v") {
                // This is a voucher, we need to do special magic to determine the ShareThing this voucher is for
                const voucherHtml = yield request({ url: thingUrl, jar: this._shareCookieJar }).promise();
                const $ = cheerio.load(voucherHtml);
                for (const type of ["album", "collection", "item", "club", "poll", "story"]) {
                    const voucherThing = $(`.voucher-link-container div[id^="${type}-"]`);
                    if (voucherThing.length === 1) {
                        slug = voucherThing[0].attribs.id.split("-")[1];
                        if (type === "album") {
                            prefix = "a";
                        }
                        if (type === "collection") {
                            prefix = "c";
                        }
                        if (type === "item") {
                            prefix = "s";
                        }
                        if (type === "club") {
                            prefix = "m";
                        }
                        if (type === "poll") {
                            prefix = "p";
                        }
                        if (type === "story") {
                            prefix = "t";
                        }
                        break;
                    }
                }
                if (prefix === "v") {
                    throw new Error(`Could not determine ShareThing for voucher url: ${thingUrl}`);
                }
            }
            return { prefix: prefix, slug: slug };
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Queries for share thing details & purchase status given a prefix & slug
     * @param prefixSlug An Object with two keys: prefix & slug
     * @returns A promise that resolves with a ShareThingExtended object
     */
    _getShareThingPurchaseStatus(prefixSlug) {
        return __awaiter(this, void 0, void 0, function* () {
            const prefix = prefixSlug.prefix;
            const slug = prefixSlug.slug;
            let type = "";
            if (prefix === "a") {
                type = "Album";
            }
            if (prefix === "c") {
                type = "Collection";
            }
            if (prefix === "s") {
                type = "Item";
            }
            if (prefix === "m") {
                type = "Club";
            }
            if (prefix === "t") {
                type = "Story";
            }
            yield this._shareLogin();
            const options = {
                uri: `${this._shareUrl}/api/v1/things/${type}/${slug}.json`,
                jar: this._shareCookieJar,
                json: true,
            };
            const rawResponse = yield request(options).promise();
            // tslint:disable-next-line:no-unsafe-any
            return rawResponse;
        });
    }
    /**
     * Retrieves a model's MFC Share 'things'
     * @param model
     * @returns A promise that resolves with an array of ShareThings objects
     */
    getShareThings(model) {
        return __awaiter(this, void 0, void 0, function* () {
            if (typeof model === "number") {
                model = Model_1.Model.getModel(this.toUserId(model));
            }
            const options = {
                uri: `${this._shareUrl}/api/v1/users/${model.uid}/things.json`,
                json: true,
            };
            const rawResponse = yield request(options).promise();
            // tslint:disable-next-line:no-unsafe-any
            return rawResponse.things;
        });
    }
    /**
     * Given the url to an MFC Share item, this will return all the ShareThings
     * that can be purchased directly on that page.
     * @param thingUrl url to a MFC Share thing
     * @returns A promise that resolves with a ShareThingExtended object
     */
    getShareThingsFromUrl(thingUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            const thing = yield this._getSharePrefixSlugFromUrl(thingUrl);
            const prefix = thing.prefix;
            const slug = thing.slug;
            thingUrl = `${this._shareUrl}/${prefix}/${slug}`;
            yield this._shareLogin();
            // Need to load the page to pull the model id from the source
            const thingHtml = yield request({ url: thingUrl, jar: this._shareCookieJar }).promise();
            const $ = cheerio.load(thingHtml);
            const trackerTag = $(`script[src^="https://www.myfreecams.com/php/tracking.php?model_id="]`);
            if (trackerTag.length !== 1 || !trackerTag[0].attribs || !trackerTag[0].attribs.src) {
                throw new Error(`Unable to determine ShareThing from url '${thingUrl}'`);
            }
            const modelIdMatch = /model_id=([0-9]+)&/.exec(trackerTag[0].attribs.src);
            if (modelIdMatch === null) {
                throw new Error(`Unable to determine ShareThing from url '${thingUrl}'`);
            }
            const modelId = parseInt(modelIdMatch[1]);
            const thingPrefixes = ["a", "c", "s", "m", "t"];
            let shareThingDetails;
            const shareThingsDetailsArray = [];
            if (thingPrefixes.indexOf(prefix) > -1) {
                shareThingDetails = yield this._getShareThingPurchaseStatus(thing);
                shareThingsDetailsArray.push(shareThingDetails);
                return shareThingsDetailsArray;
            }
            // With the model id, we can get the proper ShareThings and filter them down
            // to just those that match this URL's prefix and slug
            const allThingsForModel = yield this.getShareThings(modelId);
            return allThingsForModel.filter(t => t.prefix === prefix && t.slug === slug);
        });
    }
    /**
     * Given a ShareThing, this function will resolve to true if the current account
     * already owns the thing, or false if not.
     * @param thing A single ShareThing or a url to the Share page for a single Share thing or Voucher url
     * @returns A promise resolving true or false
     */
    isShareThingOwned(thing) {
        return __awaiter(this, void 0, void 0, function* () {
            if (typeof thing === "string") {
                const possibleThings = yield this.getShareThingsFromUrl(thing);
                if (possibleThings.length === 0) {
                    throw new Error(`No ShareThings found at url`);
                }
                // tslint:disable-next-line:no-unsafe-any
                if (possibleThings.length > 1) {
                    throw new Error(`${possibleThings.length} ShareThings found at url. Be specific.`);
                }
                thing = possibleThings[0];
            }
            if (thing.bought !== undefined) {
                return thing.bought === false ? false : true;
            }
            yield this._shareLogin();
            const thingUrl = `${this._shareUrl}/${thing.prefix}/${thing.slug}`;
            const thingHtml = yield request({ url: thingUrl, jar: this._shareCookieJar }).promise();
            const $ = cheerio.load(thingHtml);
            switch (thing.type) {
                case "Album":
                    // After we own an album there is a Tip button added to
                    // the page that allows us to tip any amount "toward" the
                    // item...whatever that means. Anyway it's only there if
                    // we already own the thing.
                    if ($("#thing-sharetip-modal").length > 0) {
                        return true;
                    }
                    break;
                case "Collection":
                    // If we own a Collection then there will be no purchase
                    // form on the page. Generally we'd prefer to confirm in
                    // the positive, but this looks like the best way to verify
                    // collections at the moment.
                    if ($("#tip-confirm-modal").length === 0) {
                        return true;
                    }
                    break;
                case "Item":
                case "Club":
                    // Items and Clubs are the most straightforward. If we own
                    // those things, Share will put a very obvious banner saying
                    // as such.
                    if ($(".alert-success").length > 0) {
                        return true;
                    }
                    break;
                case "Poll":
                    // For polls, it's possible to vote many times for many
                    // different options. This logic detects only if our latest
                    // vote was for the given ShareThing.
                    let renderScript = $("script:contains(renderPoll)").html();
                    if (renderScript !== null) {
                        renderScript = renderScript.trim();
                        if (renderScript.includes(thing.option)) {
                            return true;
                        }
                    }
                    break;
                case "Story":
                    // If the story is visible to us there will be an actual
                    // "story" element on the page. Otherwise, in its place
                    // there will be a div with the class of "story-paywall"
                    if ($("story").length > 0) {
                        return true;
                    }
                    break;
                default:
                    // Goals will fall to here. Seems reasonable as a member can't own a goal.
                    throw new Error(`Unsupported thing type '${thing.type}'`);
            }
            return false;
        });
    }
    /**
     * buyShareThing will attempt to purchase the given ShareThing
     * using the account credentials specified on Client construction.
     * This *will* spend tokens if you have them. The token amount
     * to be spent can be found on thing.token_amount.
     * @param thing The ShareThing to buy
     * @returns A promise that resolves on successful purchase
     */
    buyShareThing(thing, options = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state === exports.ClientState.ACTIVE && thing.token_amount !== null && this.tokens < thing.token_amount) {
                throw new Error(`'${thing.title}' requires ${thing.token_amount} tokens. We have ${this.tokens}`);
            }
            yield this._shareLogin();
            const thingPart = `/${thing.prefix}/${thing.slug}`;
            const thingUrl = `${this._shareUrl}${thingPart}`;
            const response = yield request({ url: thingUrl, jar: this._shareCookieJar }).promise();
            const forms = cheerio.load(response)(`form[action="${thingPart}"]`);
            // There might be multiple forms on the page in the
            // case where a thing has both password access and token
            // access, for instance. We have to find the one form that
            // takes tokens
            let purchaseForm;
            // tslint:disable-next-line:prefer-for-of
            for (let i = 0; i < forms.length; i++) {
                const found = cheerio.load(forms[i])(`input[name="tip"]`);
                if (found.length === 1) {
                    if ((thing.token_amount !== null && found[0].attribs.value === thing.token_amount.toString())
                        || (thing.type === "Poll" && found[0].attribs.value === "0")) {
                        purchaseForm = forms[i];
                        break;
                    }
                }
            }
            if (purchaseForm === undefined) {
                if (yield this.isShareThingOwned(thing)) {
                    return; // We already own the thing, no reason to throw
                }
                else {
                    throw new Error(`No purchase form was found on the page. Are we successfully logged in?`);
                }
            }
            const parsedOptions = Utils_1.createFormInput(purchaseForm, options);
            // Polls will have a tip value of 0 in the static HTML, and will then apply
            // a real token amount corresponding to your vote in the poll via script.
            // Fortunately, each poll option is actually returned as a distinct "thing"
            // via the getShareThings API. So buyShareThing does support voting in polls.
            parsedOptions.tip = thing.token_amount !== null ? thing.token_amount.toString() : "0";
            if (thing.type === "Poll") {
                // Polls also dynamically fill in an "options" value,
                // which fortunately comes down with getShareThings as well
                parsedOptions.options = thing.option;
            }
            // The auth token is a required Share parameter. If we don't have it, something has gone wrong.
            if (!("authenticity_token" in parsedOptions)) {
                throw new Error(`Could not discover authenticity_token for Share purchase. Are we successfully logged in with a real account?`);
            }
            try {
                yield request({ method: "POST", url: thingUrl, form: parsedOptions, jar: this._shareCookieJar, headers: { Host: "share.myfreecams.com", Referer: thingUrl } }).promise();
                throw new Error(`Unexpected response to Share purchase`);
            }
            catch (e) {
                // We expect a 302 redirect response back to the thingUrl on success.
                // tslint:disable-next-line:no-unsafe-any
                if (e.statusCode !== 302) {
                    throw e;
                }
                else {
                    if (yield this.isShareThingOwned(thing)) {
                        return; // Success!
                    }
                    else {
                        throw new Error(`Failed to buy thing at '${thingUrl}'`);
                    }
                }
            }
        });
    }
    /**
     * redeemShareVoucher will attempt to redeem the given MFC Share
     * voucher url using the account credentials specified on Client
     * construction.
     *
     * The returned promise will reject if you've already redeemed
     * the voucher, or the url was invalid, or you are not logged in.
     * @param voucherUrl Full url of the share voucher to redeem
     * @returns A promise that resolves on successful redemption
     */
    redeemShareVoucher(voucherUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            // Sanity check the url, we don't want to just load any given url
            const re = /^https:\/\/(share\.myfreecams\.com|mfcsha\.re)(\/v\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
            voucherUrl = voucherUrl.toLowerCase().trim();
            const match = re.exec(voucherUrl);
            if (match === null) {
                throw new Error(`Invalid share voucher url`);
            }
            // Can't POST the purchase to the shortened URL, so construct the long form here
            voucherUrl = this._shareUrl + match[2];
            yield this._shareLogin();
            // Further sanity check that we're logged in and the page has a redeem button for this voucher
            const voucherHtml = yield request({ url: voucherUrl, jar: this._shareCookieJar }).promise();
            const $ = cheerio.load(voucherHtml);
            const redeemButton = $(`a[href="${match[2]}"]`);
            if (redeemButton.length !== 1 || redeemButton.text() !== "Redeem") {
                if (yield this.isShareThingOwned(voucherUrl)) {
                    // If the voucher has already been redeemed, there will be no
                    // redeem button. But if we already own the thing the voucher
                    // was for, then there's no reason to reject.
                    return;
                }
                else {
                    throw new Error(`No redeem button found for Share voucher. Are we successfully logged in with a real account?`);
                }
            }
            // Now pull the authenticity_token from the meta headers of the page
            const authTokenElement = $(`meta[name="csrf-token"]`);
            if (authTokenElement.length !== 1 || typeof authTokenElement[0].attribs.content !== "string") {
                throw new Error(`Could not discover authenticity_token for Share voucher redemption. Are we successfully logged in with a real account?`);
            }
            const authToken = authTokenElement[0].attribs.content;
            try {
                yield request({
                    method: "POST",
                    url: voucherUrl,
                    form: { _method: "post", authenticity_token: authToken },
                    jar: this._shareCookieJar,
                    headers: { Host: "share.myfreecams.com", Referer: voucherUrl },
                }).promise();
                throw new Error(`Unexpected response to voucher redemption`);
            }
            catch (e) {
                // We expect a 302 redirect response back to the thingUrl on success.
                // tslint:disable-next-line:no-unsafe-any
                if (e.statusCode !== 302) {
                    throw e;
                }
                else {
                    if (yield this.isShareThingOwned(voucherUrl)) {
                        return; // Success!
                    }
                    else {
                        throw new Error(`Failed to redeem voucher '${voucherUrl}'`);
                    }
                }
            }
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Ban/Mute/Unban/Umute/Kick a user from a model's room where Client is Room Helper
     * @param id Model's MFC ID
     * @param action "ban", "mute", "unban", "unmute", "kick"
     * @param userIdOrNm User's MFC ID or username
     * @param clearchat true or false (optional: default is false)
     * @return {Promise} Promise that resolves if successful, rejects upon failure
     */
    _rhModAction(id, action, userIdOrNm, clearchat = false) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                // tslint:disable:no-unsafe-any
                const user = yield this.queryUser(userIdOrNm);
                const options = {
                    model: id,
                    op: action,
                };
                if (action === "kick") {
                    options.type = constants.FCTYPE.CHANOP;
                    options.chan = Client.toRoomId(id);
                    options.users = [user.sid];
                }
                else {
                    options.type = constants.FCTYPE.ZBAN;
                    options.username = user.nm;
                    options.sid = user.sid;
                }
                if (action === "mute" || action === "unmute") {
                    options.ztype = "m";
                }
                if (clearchat) {
                    options.clearchat = 1;
                }
                if (this._roomHelperStatus.get(id)) {
                    this.TxCmd(constants.FCTYPE.ROOMHELPER, 0, options.type, id, JSON.stringify(options));
                    const handler = (p) => {
                        if (p !== undefined && p.nArg1 !== undefined && p.nArg1 === id) {
                            if (p.nArg2 !== undefined) {
                                this.removeListener("ROOMHELPER", handler);
                                if (p.nArg2 === constants.FCRESPONSE.SUCCESS) {
                                    resolve(p);
                                }
                                if (p.nArg2 === constants.FCRESPONSE.ERROR) {
                                    if (typeof p.sMessage !== "undefined") {
                                        if (p.sMessage._msg === "Model offline, cannot execute room helper cmd") {
                                            this._roomHelperStatus.set(id, false);
                                            reject("Error: Client is not Room Helper");
                                        }
                                        else if (p.sMessage._msg === "Not authorized") {
                                            reject("Error: Model is offline");
                                        }
                                    }
                                    reject(p);
                                }
                            }
                        }
                    };
                    this.prependListener("ROOMHELPER", handler);
                }
                else {
                    reject("Error: Client is not Room Helper");
                }
            }));
        });
    }
    /**
     * Ban a user from a model's room where Client is Room Helper
     * @param id Model's MFC ID
     * @param userIdOrNm User's MFC ID or username
     * @param clearchat true or false (optional: default is false)
     * @return {Promise} Promise resolving with success message or rejecting with error message
     */
    banUser(id, userIdOrNm, clearchat = false) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this._rhModAction(id, "ban", userIdOrNm, clearchat ? true : false);
        });
    }
    /**
     * Unban a user from a Model's room where Client is Room Helper
     * @param id Model"s MFC ID
     * @param userIdOrNm User"s MFC ID or username
     * @return {Promise} Promise resolving with success message or rejecting with error message
     */
    unBanUser(id, userIdOrNm) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this._rhModAction(id, "unban", userIdOrNm);
        });
    }
    /**
     * Mute a user from a Model's room where Client is Room Helper
     * @param userIdOrNm User's MFC ID or username
     * @param id Model's MFC ID
     * @param clearchat true or false (optional: default is false)
     * @return {Promise} Promise resolving with success message or rejecting with error message
     */
    muteUser(id, userIdOrNm, clearchat = false) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this._rhModAction(id, "mute", userIdOrNm, clearchat ? true : false);
        });
    }
    /**
     * Unmute a user from a Model's room where Client is Room Helper
     * @param userIdOrNm User's MFC ID or username
     * @param id Model's MFC ID
     * @return {Promise} Promise resolving with success message or rejecting with error message
     */
    unMuteUser(id, userIdOrNm) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this._rhModAction(id, "unmute", userIdOrNm);
        });
    }
    /**
     * Kick a user from a Model's room where Client is Room Helper
     * @param userIdOrNm User's MFC ID or username
     * @param id Model's MFC ID
     * @return {Promise} Promise resolving with success message or rejecting with error message
     */
    kickUser(id, userIdOrNm) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this._rhModAction(id, "kick", userIdOrNm);
        });
    }
    /**
     * Set room topic for a model where Client is Room Helper
     * @param id Model's MFC ID
     * @param topic New topic
     * @return {Promise} Promise that resolves if successful, rejects upon failure
     */
    setTopic(id, topic) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                // tslint:disable:no-unsafe-any
                const options = {};
                let sTopic = topic.replace(/<wbr>/g, " %%WBR%% ");
                sTopic = sTopic.replace(/</g, "&lt;");
                sTopic = sTopic.replace(/(\S{20})/g, "$1 %%WBR%% ");
                sTopic = sTopic.replace(/(?:\s%%WBR%%\s)+/g, "<wbr>");
                options.model = id;
                options.type = constants.FCTYPE.SETWELCOME;
                options.topic = sTopic;
                if (this._roomHelperStatus.get(id)) {
                    this.TxCmd(constants.FCTYPE.ROOMHELPER, 0, constants.FCTYPE.SETWELCOME, id, JSON.stringify(options));
                    const handler = (p) => {
                        if (p !== undefined && p.nArg1 !== undefined && p.nArg1 === id) {
                            if (p.nArg2 !== undefined) {
                                this.removeListener("ROOMHELPER", handler);
                                if (p.nArg2 === constants.FCRESPONSE.SUCCESS) {
                                    resolve(p);
                                }
                                if (p.nArg2 === constants.FCRESPONSE.ERROR) {
                                    if (typeof p.sMessage !== "undefined") {
                                        if (p.sMessage._msg === "Model offline, cannot execute room helper cmd") {
                                            this._roomHelperStatus.set(id, false);
                                            reject("Error: Client is not Room Helper");
                                        }
                                        else if (p.sMessage._msg === "Not authorized") {
                                            reject("Error: Model is offline");
                                        }
                                    }
                                    reject(p);
                                }
                            }
                        }
                    };
                    this.prependListener("ROOMHELPER", handler);
                }
                else {
                    reject("Error: Client is not Room Helper");
                }
            });
        });
    }
    /**
     * Start/adjust/stop a model's countdown where Client is Room Helper
     * @param id Model's MFC ID
     * @param total Total number of tokens in countdown
     * @param countdown true if countdown is active, false to end countdown (optional)
     * @param sofar Number of tokens tipped so far in countdown (optional)
     * @return {Promise} Promise that resolves if successful, rejects upon failure
     */
    setCountdown(id, total, countdown = true, sofar) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                // tslint:disable:no-unsafe-any
                const options = {
                    model: id,
                    type: constants.FCTYPE.ROOMDATA,
                    total: total,
                    sofar: sofar ? sofar : 0,
                    countdown: countdown,
                };
                if (this._roomHelperStatus.get(id)) {
                    this.TxCmd(constants.FCTYPE.ROOMHELPER, 0, constants.FCTYPE.ROOMDATA, id, JSON.stringify(options));
                    const handler = (p) => {
                        switch (p.FCType) {
                            case constants.FCTYPE.ROOMDATA:
                                const msg = p.sMessage;
                                if (msg !== undefined && msg.model !== undefined && msg.model === id) {
                                    this.removeListener("ROOMDATA", handler);
                                    this.removeListener("ROOMHELPER", handler);
                                    resolve(p);
                                }
                                break;
                            case constants.FCTYPE.ROOMHELPER:
                                if (p.nArg2 !== undefined) {
                                    this.removeListener("ROOMDATA", handler);
                                    this.removeListener("ROOMHELPER", handler);
                                    if (p.nArg2 === constants.FCRESPONSE.SUCCESS) {
                                        resolve(p);
                                    }
                                    if (p.nArg2 === constants.FCRESPONSE.ERROR) {
                                        if (typeof p.sMessage !== "undefined") {
                                            if (p.sMessage._msg === "Model offline, cannot execute room helper cmd") {
                                                this._roomHelperStatus.set(id, false);
                                                reject("Error: Client is not Room Helper");
                                            }
                                            else if (p.sMessage._msg === "Not authorized") {
                                                reject("Error: Model is offline");
                                            }
                                        }
                                        reject(p);
                                    }
                                }
                                break;
                            default:
                                break;
                        }
                    };
                    this.prependListener("ROOMDATA", handler);
                    this.prependListener("ROOMHELPER", handler);
                }
                else {
                    reject("Error: Client is not Room Helper");
                }
            });
        });
    }
    /**
     * Retrieves all token sessions for the year and month that the given
     * date is from. The specific day or time doesn't matter. It returns
     * the whole month's data.
     * @param date
     */
    _getTokenUsageForMonth(date) {
        return __awaiter(this, void 0, void 0, function* () {
            const tokenSessions = [];
            const rawResponse = yield request({ url: `https://www.${this._baseUrl}/php/account.php?all_token_sessions=1&year=${date.getFullYear()}&month=${date.getMonth() + 1}`, headers: yield this.getHttpHeaders() }).promise();
            const $ = cheerio.load(rawResponse);
            const tableRows = $("tr").slice(1);
            tableRows.each((_index, element) => {
                const values = cheerio.load(element)(".value_td");
                if (values.length === 5) {
                    // Date, Type, Name, Amount, (plus a mysterious blank td)
                    const textParts = values.map((_index2, ele) => cheerio(ele).text().trim()).get().slice(0, -1);
                    // tslint:disable-next-line:prefer-const
                    let [time, type, recipient, tokens] = textParts;
                    // Fix up MFC's ridiculous date formatting so that we can parse it
                    time = time.replace("st", "").replace("nd", "").replace("rd", "").replace("th", "");
                    tokenSessions.push({
                        // linter bug? I can't see anything unsafe or untyped about the next line
                        // tslint:disable-next-line:no-unsafe-any
                        date: moment(time, "MMM D, YYYY, HH:mm:ss").toDate(),
                        type,
                        recipient,
                        tokens: parseInt(tokens),
                    });
                }
                else if (values.length === 1) {
                    // Comment. Comment records should have a previously added Date/Type/Name/Amount record as well
                    assert(tokenSessions.length > 0 && tokenSessions[tokenSessions.length - 1].comment === undefined);
                    // Comments might have images or other HTML elements and we'll need to pull out the emote codes
                    const tipComment = cheerio.load(values[0])("td[name=tip_comment]");
                    if (tipComment.length === 1) {
                        tokenSessions[tokenSessions.length - 1].comment = this._chatElementToString(tipComment[0]);
                    }
                    else {
                        assert.fail(`Unexpected response format: ${rawResponse}`);
                    }
                }
                else {
                    assert.fail(`Unexpected response format: ${rawResponse}`);
                }
            });
            return tokenSessions;
        });
    }
    /**
     * When client is a premium member, this method will retrieve all
     * token usage for that member between the given dates.
     *
     * This method does not require an active connection to a chat server.
     * It only requires that the client have been initialized with
     * premium credentials.
     *
     * By default, tip comments will be decoded into chat strings like
     * "I am happy :mhappy" as you would type them in MFC's chat box.
     * However the emote codes are not always available in token stats.
     * Images with no emote codes will be translated to ":unknown_emote".
     * If you'd prefer to keep the full HTML of the tip comment, including
     * any image links, you can set preserveHtml to true when constructing
     * the client. Then each comment will be returned as a raw HTML string.
     *
     * Note: I'm not sure if MFC displays tip times in a user's local time
     * zone or always Pacific US time. So this may have some timezone
     * related bugs if you really care about exactly precise timings.
     * @param startDate
     * @param endDate Optional, defaults to now
     * @returns A promise that resolves with an array of TokenSession objects
     */
    getTokenUsage(startDate, endDate) {
        return __awaiter(this, void 0, void 0, function* () {
            // moment really upsets tslint
            // tslint:disable:no-unsafe-any
            if (endDate === undefined) {
                endDate = new Date();
            }
            const startMoment = moment(startDate).startOf("month");
            const endMoment = moment(endDate).startOf("month");
            assert(endMoment.diff(startMoment) >= 0, "Invalid arguments. startDate should be before endDate (and also not in the future)");
            let tokenSessions = [];
            while (endMoment.diff(startMoment) >= 0) {
                const newTokenSessions = yield this._getTokenUsageForMonth(startMoment.toDate());
                tokenSessions = (newTokenSessions.filter((sess) => sess.date >= startDate && sess.date <= endDate)).concat(tokenSessions);
                startMoment.add(1, "month");
            }
            return tokenSessions;
            // tslint:enable:no-unsafe-any
        });
    }
    /**
     * Takes a CheerioElement that represents a single line of chat which may
     * contain emotes, and returns the string representation with the ":mhappy"
     * style emotes included wherever possible.
     */
    _chatElementToString(element) {
        let text;
        if (this._options.preserveHtml) {
            text = cheerio(element).html();
        }
        else {
            text = element.children.map((ele) => {
                if (ele.type === "text") {
                    return cheerio(ele).text().trim();
                }
                else if (ele.type === "tag") {
                    if (ele.name === "img") {
                        if (ele.attribs.title) {
                            return ele.attribs.title.trim();
                        }
                        else {
                            return ":unknown_emote";
                        }
                    }
                    else {
                        return this._chatElementToString(ele);
                    }
                }
                else {
                    return "";
                }
            }).filter(t => t !== "").join(" ");
        }
        return text;
    }
    /** Retrieves a listing of all avaiable chat log segments for a given month and year */
    _getChatLogParamsForMonth(date) {
        return __awaiter(this, void 0, void 0, function* () {
            const chatLogParams = [];
            const options = {
                hide_fonts: 0,
                hide_images: 0,
                month: date.getMonth() + 1,
                year: date.getFullYear(),
            };
            const rawResponse = yield request({ method: "POST", url: `https://www.${this._baseUrl}/php/chat_logs.php`, form: options, headers: yield this.getHttpHeaders() }).promise();
            const $ = cheerio.load(rawResponse);
            $('div[onClick*="GetLog.Execute"]').each((_index, element) => {
                // tslint:disable-next-line:no-string-literal
                const onClickText = element.attribs["onclick"];
                const onClickObj = Utils_1.parseJsObj(onClickText.slice(onClickText.indexOf("{"), onClickText.lastIndexOf("}") + 1));
                const cc = cheerio.load(element);
                const extendedParams = Object.assign({}, onClickObj, { name: cc(".list_name").text().trim(), type: cc(".list_type").text().trim() });
                chatLogParams.push(extendedParams);
            });
            return chatLogParams;
        });
    }
    /** Retrieves a single chat log segment from MFC */
    _getChatLog(params, page = 1) {
        return __awaiter(this, void 0, void 0, function* () {
            let fullChatLog = [];
            const options = {
                log_date: params.log_date,
                from_id: 0,
                to_id: params.to_id,
                channel_id: params.channel_id,
                page,
                token_session_id: params.token_session_id,
                sessiontype: params.sessiontype,
                hide_images: 0,
                hide_fonts: 0,
                use_legacy_player: 0,
            };
            const rawResponse = yield request({ url: `https://www.${this._baseUrl}/php/chat_logs.php`, qs: options, headers: yield this.getHttpHeaders() }).promise();
            const $ = cheerio.load(rawResponse);
            const chatLines = $(".dialogue_time, .dialogue_name, .dialogue_content");
            chatLines.each((_index, element) => {
                const cc = cheerio.load(element);
                if (element.attribs.class.indexOf("dialogue_time") !== -1) {
                    // tslint:disable-next-line:no-unsafe-any
                    fullChatLog.push({ time: moment(`${params.log_date} ${cc(".dialogue_time").text()}`, "YYYY-MM-DD hh:mm:ss A").toDate() });
                }
                else if (element.attribs.class.indexOf("dialogue_name") !== -1) {
                    fullChatLog[fullChatLog.length - 1].user = cc(".dialogue_name").text().trim().replace(":", "");
                }
                else if (element.attribs.class.indexOf("dialogue_content") !== -1) {
                    if (cc(".MfcXTip").length !== 0) {
                        const tipContent = this._chatElementToString(cc(".MfcXTip")[0]);
                        fullChatLog[fullChatLog.length - 1].user = tipContent.split(" ")[0];
                        fullChatLog[fullChatLog.length - 1].text = tipContent; // @TODO Should we strip off the username here?
                        fullChatLog[fullChatLog.length - 1].type = "tip";
                        // @TODO - Should we parse out the tip amount too?
                        // @TODO - Also, channel messages like topic updates are mixed in here too. Should we special case those?
                    }
                    else {
                        fullChatLog[fullChatLog.length - 1].text = this._chatElementToString(cc(".dialogue_content")[0]);
                        fullChatLog[fullChatLog.length - 1].type = "chat";
                    }
                }
            });
            // If the log is paginated, and we're on the first page, recurse
            const pages = $('a[onClick*="GetLog.Execute"]');
            if (pages.length > 0 && page === 1) {
                const pageParams = [];
                pages.each((_index, element) => {
                    // tslint:disable-next-line:no-string-literal
                    const onClickText = element.attribs["onclick"];
                    const onClickObj = Utils_1.parseJsObj(onClickText.slice(onClickText.indexOf("{"), onClickText.lastIndexOf("}") + 1));
                    const extendedParams = Object.assign({}, onClickObj, { name: params.name, type: params.type });
                    const nextPage = parseInt(element.lastChild.data.trim());
                    pageParams.push([extendedParams, nextPage]);
                });
                for (const nextParams of pageParams) {
                    const nextPageResult = yield this._getChatLog(nextParams[0], nextParams[1]);
                    fullChatLog = fullChatLog.concat(nextPageResult);
                }
            }
            // @TODO - Parse out the private video URL if there is one and return it as well
            // @TODO - It probably makes more sense for this function to return a complete ChatLog object
            return fullChatLog;
        });
    }
    /**
     * When client is a premium member, this method will retrieve all
     * chat archives for that member between the given dates.
     *
     * This method does not require an active connection to a chat server.
     * It only requires that the client have been initialized with
     * premium credentials.
     *
     * By default, chat will be decoded into strings like "I am happy :mhappy"
     * as you would type them in MFC's chat box. However the emote codes are
     * not always available in chat archives. Images with no emote codes will
     * be translated to ":unknown_emote". If you'd prefer to keep the full
     * HTML of the message, including any image links, you can set preserveHtml
     * to true when constructing the client. Then each chat message will be
     * returned as a raw HTML string.
     *
     * Note: I'm not sure if MFC displays times in a user's local time
     * zone or always Pacific US time. So this may have some timezone
     * related bugs if you really care about exactly precise timings.
     * @param startDate
     * @param endDate Optional, defaults to now
     * @param userId Only return logs involving this model or user ID. If
     * this value is a model ID, it will include all public chat in that
     * model's room. By default, all logs for all users in the given time
     * range will be returned.
     * @returns A promise that resolves with an array of ChatLog objects
     */
    getChatLogs(startDate, endDate, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            // tslint:disable:no-unsafe-any
            if (endDate === undefined) {
                endDate = new Date();
            }
            const logs = [];
            const startDay = moment(startDate).startOf("day").toDate();
            const endDay = moment(endDate).startOf("day").toDate();
            const startMonth = moment(startDate).startOf("month");
            const endMonth = moment(endDate).startOf("month");
            while (endMonth.diff(startMonth) >= 0) {
                for (const params of yield this._getChatLogParamsForMonth(startMonth.toDate())) {
                    const logDate = moment(params.log_date, "YYYY-MM-DD").toDate();
                    if (logDate >= startDay && logDate <= endDay) {
                        const logUserId = parseInt(params.to_id);
                        if (userId === undefined || userId === logUserId) {
                            logs.push({
                                logDate,
                                toUserId: logUserId,
                                toChannelId: isNaN(parseInt(params.channel_id)) ? undefined : parseInt(params.channel_id),
                                sessionType: parseInt(params.sessiontype),
                                lines: (yield this._getChatLog(params)).filter((line) => line.time >= startDate && line.time <= endDate),
                            });
                        }
                    }
                }
                startMonth.add(1, "month");
            }
            return logs;
            // tslint:enable:no-unsafe-any
        });
    }
    /**
     * Joins the public chat room of the given model
     * or the given channel ID
     * @param id Model ID or room/channel ID to join
     * @returns A promise that resolves after successfully
     * joining the chat room and rejects if the join fails
     * for any reason (you're banned, region banned, or
     * you're a guest and the model is not online)
     */
    joinRoom(id) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                const modelId = this.toUserId(id);
                const roomId = this._negotiateChannelForJoining(this._toFreeIfModel(id), modelId);
                let resultHandler, joinTimer;
                const onTimeout = () => {
                    this.removeListener("JOINCHAN", resultHandler);
                    this.removeListener("ZBAN", resultHandler);
                    this.removeListener("BANCHAN", resultHandler);
                    this.removeListener("CMESG", resultHandler);
                    reject(`Failed to join ${roomId}`);
                };
                joinTimer = setTimeout(onTimeout, 5000);
                resultHandler = (p) => {
                    if (p.nTo === roomId || p.nArg1 === roomId) {
                        clearTimeout(joinTimer);
                        this.removeListener("JOINCHAN", resultHandler);
                        this.removeListener("ZBAN", resultHandler);
                        this.removeListener("BANCHAN", resultHandler);
                        this.removeListener("CMESG", resultHandler);
                        switch (p.FCType) {
                            case constants.FCTYPE.CMESG:
                                // Success!
                                resolve(p);
                                break;
                            case constants.FCTYPE.JOINCHAN:
                                switch (p.nArg2) {
                                    case constants.FCCHAN.JOIN:
                                        // Also success!
                                        resolve(p);
                                        break;
                                    case constants.FCCHAN.PART:
                                        // Probably a bad model ID
                                        reject(p);
                                        break;
                                    default:
                                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, () => `WARNING: joinRoom received an unexpected JOINCHAN response ${p.toString()}`);
                                        break;
                                }
                                break;
                            case constants.FCTYPE.ZBAN:
                            case constants.FCTYPE.BANCHAN:
                                reject(p);
                                break;
                            default:
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, `WARNING: joinRoom received the impossible`);
                                reject(p);
                                break;
                        }
                    }
                };
                // Listen for possible responses
                this.addListener("JOINCHAN", resultHandler);
                this.addListener("ZBAN", resultHandler);
                this.addListener("BANCHAN", resultHandler);
                this.addListener("CMESG", resultHandler);
                let nArg2 = constants.FCCHAN.JOIN | constants.FCCHAN.HISTORY;
                const channelType = this.getChannelType(roomId);
                if (channelType === constants.ChannelType.NonFreeChat) {
                    const modelState = Model_1.Model.getModel(modelId).bestSession.vs;
                    if (modelState === constants.STATE.GroupShow) {
                        nArg2 = constants.FCGROUP.SESSION;
                    }
                }
                this.TxCmd(constants.FCTYPE.JOINCHAN, 0, roomId, nArg2);
            });
        });
    }
    /**
     * Leaves the public chat room of the given model
     * or the given chat channel
     * @param id Model ID or room/channel ID to leave
     * @returns A promise that resolves immediately
     */
    leaveRoom(id) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._state === exports.ClientState.ACTIVE) {
                id = this._toFreeIfModel(id);
                this.TxCmd(constants.FCTYPE.JOINCHAN, 0, id, constants.FCCHAN.PART);
            }
            // Else, if we don't have a connection then we weren't really in the
            // room in the first place. No real point to raising an exception here
            // so just exit silently instead.
        });
    }
    /**
     * Queries MFC for the latest state of a model or member
     *
     * This method does poll the server for the latest model status, which can
     * be useful in some situations, but it is **not the quickest way to know
     * when a model's state changes**. Instead, to know the instant a model
     * enters free chat, keep a Client connected and listen for changes on her
     * Model instance. For example:
     *
     *   ```javascript
     *   // Register a callback whenever AspenRae's video
     *   // state changes
     *   mfc.Model.getModel(3111899)
     *     .on("vs", (model, before, after) => {
     *       // This will literally be invoked faster than
     *       // you would see her cam on the website.
     *       // There is no faster way.
     *       if (after === mfc.STATE.FreeChat) {
     *         // She's in free chat now!
     *       }
     *   });
     *   ```
     * @param user Model or member name or ID
     * @returns A promise that resolves with a Message
     * containing the user's current details or undefined
     * if the given user was not found
     * @example
     * // Query a user, which happens to be a model, by name
     * client.queryUser("AspenRae").then((msg) => {
     *     if (msg === undefined) {
     *         console.log("AspenRae probably temporarily changed her name");
     *     } else {
     *         //Get the full Model instance for her
     *         let AspenRae = mfc.Model.getModel(msg.uid);
     *         //Do stuff here...
     *     }
     * });
     *
     * // Query a user by ID number
     * client.queryUser(3111899).then((msg) => {
     *     console.log(JSON.stringify(msg));
     *     //Will print something like:
     *     //  {"sid":0,"uid":3111899,"nm":"AspenRae","lv":4,"vs":127}
     * });
     *
     * // Query a member by name and check their status
     * client.queryUser("MyPremiumMemberFriend").then((msg) => {
     *     if (msg) {
     *         if (msg.vs !== mfc.STATE.Offline) {
     *             console.log("My friend is online!");
     *         } else {
     *             console.log("My friend is offline");
     *         }
     *     } else {
     *         console.log("My friend no longer exists by that name");
     *     }
     * });
     *
     * // Force update a model's status, without caring about the result here
     * // Potentially useful when your logic is in model state change handlers
     * client.queryUser(3111899);
     */
    queryUser(user) {
        return __awaiter(this, void 0, void 0, function* () {
            // The number used for the queryId is returned by the chat server
            // and used to correlate the server response to the correct client
            // query. The exact number doesn't really matter except that it
            // should be unique if you're potentially sending multiple
            // USERNAMELOOKUP queries simultaneously (which we might be).
            // Starting with 20 simply because that's what MFC's web client
            // code uses. Literally any number would work.
            Client._userQueryId = Client._userQueryId !== undefined ? Client._userQueryId : 20;
            const queryId = Client._userQueryId++;
            return new Promise((resolve) => {
                const handler = (p) => {
                    // If this is our response
                    if (p.nArg1 === queryId) {
                        this.removeListener("USERNAMELOOKUP", handler);
                        if (typeof p.sMessage === "string" || p.sMessage === undefined) {
                            // These states mean the user wasn't found.
                            // Be a little less ambiguous in our response by resolving
                            // with undefined in both cases.
                            resolve(undefined);
                        }
                        else {
                            resolve(p.sMessage);
                        }
                    }
                };
                this.prependListener("USERNAMELOOKUP", handler);
                if (typeof user === "number") {
                    this.TxCmd(constants.FCTYPE.USERNAMELOOKUP, 0, queryId, user);
                }
                else if (typeof user === "string") {
                    this.TxCmd(constants.FCTYPE.USERNAMELOOKUP, 0, queryId, 0, user);
                }
                else {
                    throw new Error("Invalid argument");
                }
            });
        });
    }
    /**
     * Connects to MFC
     *
     * Logging in is optional because not all queries to the server require you to log in.
     * For instance, MFC servers will respond to a USERNAMELOOKUP request without
     * requiring a login. However for most cases you probably do want to log in.
     * @param [doLogin] If True, log in with the credentials provided at Client construction.
     * If False, do not log in. Default is True
     * @returns A promise that resolves when the connection has been established
     * @example <caption>Most common case is simply to connect, log in, and start processing events</caption>
     * const mfc = require("MFCAuto");
     * const client = new mfc.Client();
     *
     * // Set up any desired callback hooks here using one or more of:
     * //   - mfc.Model.on(...) - to handle state changes for all models
     * //   - mfc.Model.getModel(...).on(...) - to handle state changes for only
     * //     the specific model retrieved via the .getModel call
     * //   - client.on(...) - to handle raw MFC server events, this is advanced
     *
     * // Then connect so that those events start processing.
     * client.connect();
     * @example <caption>If you need some logic to run after connection, use the promise chain</caption>
     * const mfc = require("MFCAuto");
     * const client = new mfc.Client();
     * client.connect()
     *      .then(() => {
     *          // Do whatever requires a connection here
     *      })
     *      .catch((reason) => {
     *          // Something went wrong
     *      });
     */
    connect(doLogin = true) {
        return __awaiter(this, void 0, void 0, function* () {
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] connect(${doLogin}), state: ${exports.ClientState[this._state]}`);
            if (this._state === exports.ClientState.PENDING) {
                // If we're already trying to connect, just wait until that works
                return this.ensureConnected();
            }
            else if (this._state === exports.ClientState.IDLE) {
                // If we're not already trying to connect, start trying
                this._choseToLogIn = doLogin;
                this._state = exports.ClientState.PENDING;
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] State: ${this._state}`);
                return new Promise((resolve, reject) => {
                    // Reset any read buffers so we are in a consistent state
                    this._streamBuffer = Buffer.alloc(0);
                    this._streamPosition = 0;
                    this._streamWebSocketBuffer = "";
                    // If we can't connect for any reason, we'll keep retrying
                    // recursively forever, by design. Whenever we do eventually
                    // manage to connect, we need to resolve this promise so
                    // that callers can be assured we're always connected on
                    // .then. If the user manually calls .disconnect() before
                    // a connection can be established, we will reject the
                    // returned promise.
                    this.ensureConnected(this._options.connectionTimeout)
                        .then(() => resolve())
                        .catch((reason) => reject(reason));
                    this._ensureServerConfigIsLoaded().then(() => {
                        if (!this._options.useWebSockets) {
                            // Use good old TCP sockets and the older Flash method of
                            // communicating with the MFC chat servers
                            const chatServer = this.serverConfig.chat_servers[Math.floor(Math.random() * this.serverConfig.chat_servers.length)];
                            Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, `Connecting to () => ${this._options.camYou ? "CamYou" : "MyFreeCams:"} chat server ${chatServer}...`);
                            this._client = net.connect(constants.FLASH_PORT, chatServer + `.${this._baseUrl}`, () => {
                                // Connecting without logging in is the rarer case, so make the default to log in
                                if (doLogin) {
                                    this._disconnectIfNo(constants.FCTYPE.LOGIN, this._options.loginTimeout, "Server did not respond to the login request, retrying");
                                    this.login()
                                        .catch((reason) => {
                                        this._disconnected(`>>> Login failed: ${reason}`);
                                    });
                                }
                                this._state = exports.ClientState.ACTIVE;
                                this._currentConnectionStartTime = Date.now();
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] State: ${this._state}`);
                                Client._currentReconnectSeconds = Client._initialReconnectSeconds;
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] emitting: CLIENT_CONNECTED, doLogin: ${doLogin}`);
                                this.emit("CLIENT_CONNECTED", doLogin);
                            });
                            this._client.on("data", (data) => {
                                this._readData(data);
                            });
                            this._client.on("end", () => {
                                this._disconnected("Socket end");
                            });
                            this._client.on("error", (err) => {
                                this._disconnected(`Socket error: ${err}`);
                            });
                            this._client.on("close", () => {
                                this._disconnected("Socket close");
                            });
                        }
                        else {
                            // Use websockets and the more modern way of
                            // communicating with the MFC chat servers
                            const wsSrvs = Object.getOwnPropertyNames(this.serverConfig.websocket_servers);
                            const chatServer = wsSrvs[Math.floor(Math.random() * wsSrvs.length)];
                            Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, ">>> Connecting to MyFreeCams chat server " + colors.green(chatServer));
                            this._client = new WebSocket(`wss://${chatServer}.${this._baseUrl}:${constants.WEBSOCKET_PORT}/fcsl`, {
                                // protocol: this.serverConfig.websocket_servers[chatServer] as string,
                                origin: `https://m.${this._baseUrl}`,
                            });
                            this._client.on("open", () => {
                                this._client.send("fcsws_20180422\n\0");
                                // Connecting without logging in is the rarer case, so make the default to log in
                                if (doLogin) {
                                    this._disconnectIfNo(constants.FCTYPE.LOGIN, this._options.loginTimeout, "Server did not respond to the login request, retrying");
                                    this.login()
                                        .catch((reason) => {
                                        this._disconnected(`Login failed: ${reason}`);
                                    });
                                }
                                this._state = exports.ClientState.ACTIVE;
                                this._currentConnectionStartTime = Date.now();
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] State: ${this._state}`);
                                Client._currentReconnectSeconds = Client._initialReconnectSeconds;
                                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] emitting: CLIENT_CONNECTED, doLogin: ${doLogin}`);
                                this.emit("CLIENT_CONNECTED", doLogin);
                            });
                            this._client.on("message", (message) => {
                                this._readWebSocketData(message);
                            });
                            this._client.on("close", () => {
                                this._disconnected("WebSocket close");
                            });
                            this._client.on("error", (event) => {
                                this._disconnected(`WebSocket error: ${event.message}`);
                            });
                        }
                        // Keep the server connection alive
                        this._keepAliveTimer = setInterval(() => this._keepAlive(), 
                        // WebSockets need the keepAlive ping every 15 seconds
                        // Flash Sockets need it only once every 2 minutes
                        this._options.useWebSockets !== false ? 15 * 1000 : 120 * 1000);
                    }).catch((reason) => {
                        this._disconnected(`Error while connecting: ${reason}`);
                    });
                });
            }
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Keeps the server collection alive by regularly sending NULL 'pings'.
     * Also monitors the connection to ensure traffic is flowing and kills
     * the connection if not. A setInterval loop calling this function is
     * creating when a connection is established and cleared on disconnect
     * @access private
     */
    _keepAlive() {
        Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] _keepAlive() ${this._state}/${this._currentConnectionStartTime}`);
        if (this._state === exports.ClientState.ACTIVE && this._currentConnectionStartTime) {
            const now = Date.now();
            const lastPacketDuration = now - (this._lastPacketTime || this._currentConnectionStartTime);
            const lastStatePacketDuration = now - (this._lastStatePacketTime || this._currentConnectionStartTime);
            if (lastPacketDuration > this._options.silenceTimeout
                || (this._choseToLogIn && lastStatePacketDuration > this._options.stateSilenceTimeout)) {
                if (this._client !== undefined) {
                    Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] _keepAlive silence tripped, lastPacket: ${lastPacketDuration}, lastStatePacket: ${lastStatePacketDuration}`);
                    const msg = `Server has not responded for too long, forcing disconnect`;
                    Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, msg);
                    this._disconnected(msg);
                }
            }
            else {
                this.TxCmd(constants.FCTYPE.NULL, 0, 0, 0);
            }
        }
    }
    /**
     * Internal MFCAuto use only
     *
     * Helper utility that sets up a timer which will disconnect this client
     * after the given amount of time, if at least one instance of the given
     * packet type isn't received before then. Mainly used as a LOGIN timeout
     *
     * If the client disconnects on it own before the timer is up, no action
     * is taken
     * @param fctype
     * @param after
     * @param msg
     * @access private
     */
    _disconnectIfNo(fctype, after, msg) {
        assert.notStrictEqual(this._state, exports.ClientState.IDLE);
        const typeName = constants.FCTYPE[fctype];
        let stopper, timer;
        timer = setTimeout(() => {
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, msg);
            stopper();
            this._disconnected(msg);
        }, after);
        stopper = () => {
            clearTimeout(timer);
            this.removeListener("CLIENT_MANUAL_DISCONNECT", stopper);
            this.removeListener("CLIENT_DISCONNECTED", stopper);
            this.removeListener(typeName, stopper);
        };
        this.once("CLIENT_MANUAL_DISCONNECT", stopper);
        this.once("CLIENT_DISCONNECTED", stopper);
        this.once(typeName, stopper);
        return timer;
    }
    /**
     * Returns a Promise that resolves when we have an active connection to the
     * server, which may be instantly or may be hours from now.
     *
     * When Client.connect (or .connectAndWaitForModels) is called, Client
     * will initiate a connection the MFC's chat servers and then try to
     * maintain an active connection forever. Of course, network issues happen
     * and the server connection may be lost temporarily. Client will try to
     * reconnect. However, many of the advanced features of Client, such as
     * .joinRoom, .sendChat, or .TxCmd, require an active connection and will
     * throw if there is not one at the moment.
     *
     * This is a helper function for those cases.
     *
     * This function does not *cause* connection or reconnection.
     * @param [timeout] Wait maximally this many milliseconds
     * Leave undefined for infinite, or set to -1 for no waiting.
     * @returns A Promise that resolves when a connection is present, either
     * because we were already connected or because we succeeded in our
     * reconnect attempt, and rejects when either the given timeout is reached
     * or client.disconnect() is called before we were able to establish a
     * connection. It also rejects if the user has not called .connect at all
     * yet.
     */
    ensureConnected(timeout) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                if (this._state === exports.ClientState.IDLE) {
                    // We're not connected or attempting to reconnect
                    reject(new Error("Call connect() or connectAndWaitForModels() before attempting this"));
                }
                else if (this._state === exports.ClientState.ACTIVE) {
                    // We're apparently already connected
                    resolve();
                }
                else if (timeout === -1) {
                    // Doesn't look like we're connected but the caller asked
                    // to not wait for connection, bail
                    reject(new Error("Not currently connected"));
                }
                else {
                    // Doesn't look like we're connected, set up all the listeners
                    // required to wait for reconnection or timeout
                    let timer;
                    let resolver, rejecter;
                    if (timeout) {
                        timer = setTimeout(() => {
                            this.removeListener("CLIENT_MANUAL_DISCONNECT", rejecter);
                            this.removeListener("CLIENT_CONNECTED", resolver);
                            reject(new Error(`Timeout before connection could be established: ${timeout}ms`));
                        }, timeout);
                    }
                    resolver = () => {
                        this.removeListener("CLIENT_MANUAL_DISCONNECT", rejecter);
                        if (timer) {
                            clearTimeout(timer);
                        }
                        resolve();
                    };
                    rejecter = () => {
                        this.removeListener("CLIENT_CONNECTED", resolver);
                        if (timer) {
                            clearTimeout(timer);
                        }
                        reject(new Error("disconnect() requested before connection could be established"));
                    };
                    this.prependOnceListener("CLIENT_MANUAL_DISCONNECT", rejecter);
                    this.prependOnceListener("CLIENT_CONNECTED", resolver);
                }
            });
        });
    }
    /**
     * Internal MFCAuto use only
     *
     * Called by internal components when it's detected that we've lost our
     * connection to the server. It handles some cleanup tasks and the
     * reconnect logic. Users should definitely not be calling this function.
     * @access private
     */
    _disconnected(reason) {
        if (this._state !== exports.ClientState.IDLE) {
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, `>>> Disconnected from ${this._baseUrl}${this._manualDisconnect ? "" : `\n                        >>> ${reason}`}`);
            this._completedModels = false;
            this._completedTags = false;
            this._webApiToken = undefined;
            this._roomHelperStatus.clear();
            this._availableClubShows.clear();
            if (this._client !== undefined) {
                this._client.removeAllListeners();
                // tslint:disable-next-line:only-arrow-functions
                this._client.on("error", function () { });
                try {
                    if (this._client instanceof net.Socket) {
                        this._client.end();
                    }
                    else {
                        this._client.close();
                    }
                }
                catch (e) {
                    // Ignore
                }
                this._client = undefined;
            }
            this.sessionId = 0;
            this._currentConnectionStartTime = undefined;
            this._lastPacketTime = undefined;
            this._lastStatePacketTime = undefined;
            if (this._keepAliveTimer !== undefined) {
                clearInterval(this._keepAliveTimer);
                this._keepAliveTimer = undefined;
            }
            if (this._choseToLogIn === true && Client._connectedClientCount > 0) {
                Client._connectedClientCount--;
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] connectedClientCount: ${Client._connectedClientCount}`);
            }
            if (this.password === "guest" && this.username.startsWith("Guest")) {
                // If we had a successful guest login before, we'll have changed
                // username to something like Guest12345 or whatever the server assigned
                // to us. That is not valid to log in again, so reset it back to guest.
                this.username = "guest";
            }
            if (!this._manualDisconnect) {
                this._state = exports.ClientState.PENDING;
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] State: ${this._state}`);
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, () => `>>> Reconnecting in ${Client._currentReconnectSeconds} seconds ...`);
                clearTimeout(this._reconnectTimer);
                // tslint:disable:align
                this._reconnectTimer = setTimeout(() => {
                    // Set us to IDLE briefly so that .connect
                    // will not ignore the request. It will set
                    // the state back to PENDING before turning
                    // over execution
                    this._state = exports.ClientState.IDLE;
                    this.connect(this._choseToLogIn).catch((r) => {
                        this._disconnected(`>>> Reconnection failed: ${r}`);
                    });
                    this._reconnectTimer = undefined;
                }, Client._currentReconnectSeconds * 1000);
                // tslint:enable:align
                // Gradually increase the reconnection time up to Client.maximumReconnectSeconds.
                // currentReconnectSeconds will be reset to initialReconnectSeconds once we have
                // successfully logged in.
                if (Client._currentReconnectSeconds < Client._maximumReconnectSeconds) {
                    Client._currentReconnectSeconds *= Client._reconnectBackOffMultiplier;
                }
            }
            else {
                this._state = exports.ClientState.IDLE;
                Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] State: ${this._state}`);
                this._manualDisconnect = false;
            }
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] emitting: CLIENT_DISCONNECTED, _choseToLogIn: ${this._choseToLogIn}`);
            this.emit("CLIENT_DISCONNECTED", this._choseToLogIn);
            if (Client._connectedClientCount === 0) {
                Model_1.Model.reset();
            }
        }
    }
    /**
     * Logs in to MFC. This should only be called after Client connect(false);
     * See the comment on Client's constructor for details on the password to use.
     */
    login(username, password) {
        return __awaiter(this, void 0, void 0, function* () {
            // connectedClientCount is used to track when all clients receiving SESSIONSTATE
            // updates have disconnected, and as those are only sent for logged-in clients,
            // we shouldn't increment the counter for non-logged-in clients
            Client._connectedClientCount++;
            this._choseToLogIn = true;
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] _connectedClientCount: ${Client._connectedClientCount}`);
            if (username !== undefined) {
                this.username = username;
            }
            if (password !== undefined) {
                this.password = password;
            }
            const loginCompletePromise = new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                this.prependOnceListener("LOGIN", (packet) => {
                    // Store username and session id returned by the login response packet
                    if (packet.nArg1 !== 0) {
                        const msg = `>>> Login failed for user '${colors.cyan(this.username)}' password '${colors.cyan(this.password)}'`;
                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.ERROR, msg);
                        reject(msg);
                    }
                    else {
                        if (typeof packet.sMessage === "string") {
                            // If we're logged in with a real account, go ahead and
                            // retrieve a web api token to extend our capabilities
                            if (this.username !== "guest") {
                                const supplementalData = {
                                    r: Math.round(Math.random() * 1000000),
                                    mode: "supplemental_data",
                                };
                                this.getHttpHeaders()
                                    .then((result) => {
                                    return request({ method: "POST", url: `https://www.${this._baseUrl}/php/client_info.php`, form: supplementalData, headers: result });
                                })
                                    .then((result) => {
                                    try {
                                        const resultObj = JSON.parse(result); // It's an array but not exactly like that. Just want to silence TypeScript...
                                        for (const obj of resultObj) {
                                            if (obj && obj.token) {
                                                this._webApiToken = obj.token;
                                                break;
                                            }
                                        }
                                        if (this._webApiToken === undefined) {
                                            Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, `WARNING: client_info.php supplementalData did not contain a web api token '${result}'`);
                                        }
                                    }
                                    catch (e) {
                                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, `WARNING: client_info.php returned invalid JSON on supplementalData '${result}', ${e}`);
                                    }
                                })
                                    .catch((reason) => {
                                    Utils_1.logWithLevelInternal(Utils_1.LogLevel.WARNING, `WARNING: client_info.php returned an error on supplementalData '${reason}'`);
                                });
                            }
                            this.sessionId = packet.nTo;
                            this.uid = packet.nArg2;
                            this.username = packet.sMessage;
                            Utils_1.logWithLevelInternal(Utils_1.LogLevel.INFO, `>>> Login handshake completed.\n                        >>> Logged in as '${colors.cyan(this.username)}' with sessionId ${colors.cyan(this.sessionId)}`);
                            // Start the flow of ROOMDATA updates
                            this.ensureConnected(-1)
                                .then(() => this.TxCmd(constants.FCTYPE.ROOMDATA, 0, constants.FCCHAN.JOIN, 0))
                                .catch(() => { });
                            resolve();
                        }
                        else {
                            reject(`Unexpected FCTYPE_LOGIN response format: '${JSON.stringify(packet.sMessage)}'`);
                        }
                    }
                });
            }));
            if (!this._options.modernLogin) {
                const credentials = `${this._options.camYou ? constants.PLATFORM.CAMYOU : constants.PLATFORM.MFC}/${this.username}:${yield this.getPassCode()}`;
                this.TxCmd(constants.FCTYPE.LOGIN, 0, !this._options.useWebSockets ? constants.LOGIN_VERSION.FLASH : constants.LOGIN_VERSION.WEBSOCKET, 0, credentials);
            }
            else {
                // Ensure we can get the passcode before we hook up the EventEmitter callback
                const currentPassCode = yield this.getPassCode();
                const extDataHandler = (packet) => {
                    if (packet.nArg1 === constants.FCTYPE.LOGIN) {
                        const credentials = `${packet.sMessage}@${this._options.camYou ? constants.PLATFORM.CAMYOU : constants.PLATFORM.MFC}/${this.username}:${currentPassCode}`;
                        this.TxCmd(constants.FCTYPE.LOGIN, 0, !this._options.useWebSockets ? constants.LOGIN_VERSION.FLASH : constants.LOGIN_VERSION.WEBSOCKET, 0, credentials);
                        this.removeListener("EXTDATA", extDataHandler);
                    }
                };
                this.prependListener("EXTDATA", extDataHandler);
                const result = yield this._challenge();
                this.TxCmd(constants.FCTYPE.LOGIN, 0, constants.FCTYPE.EXTDATA, 0, encodeURIComponent(result));
            }
            return loginCompletePromise;
        });
    }
    _challenge() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                const phantomLocation = Utils_1.findDependentExe("phantomjs");
                Utils_1.spawnOutput(phantomLocation, ["--web-security=no", path.join(__dirname, "challenge.js"), this._options.camYou ? "2" : "1"])
                    .then((output) => {
                    let obj;
                    try {
                        // tslint:disable-next-line:no-unsafe-any
                        obj = JSON.parse(output);
                    }
                    catch (e) {
                        reject(`Failed to parse challenge result: ${output}`);
                        return;
                    }
                    if (typeof obj !== "object" || obj.err !== 0) {
                        reject(`Challenge received an invalid response ${JSON.stringify(obj)}`);
                    }
                    else {
                        resolve(JSON.stringify(obj));
                    }
                })
                    .catch((error) => {
                    reject(error);
                });
            });
        });
    }
    /**
     * Connects to MFC and logs in, just like this.connect(true),
     * but in this version the returned promise resolves when the initial
     * list of online models has been fully populated.
     * If you're logged in as a user with friended models, this will
     * also wait until your friends list is completely loaded.
     *
     * This method always logs in, because MFC servers won't send information
     * for all online models until you've logged as at least a guest.
     * @returns A promise that resolves when the model list is complete
     */
    connectAndWaitForModels() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._state !== exports.ClientState.ACTIVE) {
                return new Promise((resolve, reject) => {
                    this.prependOnceListener("CLIENT_MODELSLOADED", resolve);
                    this.connect(true).catch((r) => reject(r));
                });
            }
        });
    }
    /**
     * Disconnects a connected client instance
     * @returns A promise that resolves when the disconnect is complete
     */
    disconnect() {
        return __awaiter(this, void 0, void 0, function* () {
            Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] disconnect(), state: ${exports.ClientState[this._state]}`);
            if (this._state !== exports.ClientState.IDLE) {
                return new Promise((resolve) => {
                    this.emit("CLIENT_MANUAL_DISCONNECT");
                    this._manualDisconnect = true;
                    if (this._keepAliveTimer !== undefined) {
                        clearInterval(this._keepAliveTimer);
                        this._keepAliveTimer = undefined;
                    }
                    if (this._reconnectTimer !== undefined) {
                        clearTimeout(this._reconnectTimer);
                        this._reconnectTimer = undefined;
                    }
                    if (this._state === exports.ClientState.ACTIVE) {
                        this.prependOnceListener("CLIENT_DISCONNECTED", () => {
                            resolve();
                        });
                    }
                    if (this._client !== undefined) {
                        if (this._client instanceof net.Socket) {
                            this._client.end();
                        }
                        else {
                            this._client.close();
                        }
                    }
                    // If we're not currently connected, then calling
                    // this._client.end() will not cause CLIENT_DISCONNECTED
                    // to be emitted, so we shouldn't wait for that.
                    if (this._state !== exports.ClientState.ACTIVE) {
                        this._state = exports.ClientState.IDLE;
                        Utils_1.logWithLevelInternal(Utils_1.LogLevel.DEBUG, () => `[CLIENT] State: ${this._state}`);
                        this._manualDisconnect = false;
                        resolve();
                    }
                });
            }
        });
    }
    /**
     * Retrieves the HLS url for the given model (free chat only)
     * @param model
     * @returns A string containing the HLS url for model's free chat broadcast
     */
    getHlsUrl(model) {
        if (typeof model === "number") {
            model = Model_1.Model.getModel(this.toUserId(model));
        }
        const camserv = model.bestSession.camserv;
        if (!camserv || !this.serverConfig || model.bestSession.vs !== constants.STATE.FreeChat) {
            return undefined;
        }
        const roomId = this.toChannelId(model.uid);
        const roomprefix = this._options.camYou ? "cam" : "mfc";
        let videoserv;
        if (this.serverConfig.wzobs_servers && this.serverConfig.wzobs_servers.hasOwnProperty(camserv)) {
            // high-def wowza
            videoserv = this.serverConfig.wzobs_servers[camserv];
            return `https://${videoserv}.${this._baseUrl}:443/NxServer/ngrp:${roomprefix}_${model.bestSession.phase}_${roomId}.f4v_mobile/playlist.m3u8?nc=${Math.random().toString().replace("0.", "")}`;
        }
        else if (this.serverConfig.ngvideo_servers && this.serverConfig.ngvideo_servers.hasOwnProperty(camserv)) {
            // high-def nginx
            videoserv = this.serverConfig.ngvideo_servers[camserv];
            return `https://${videoserv}.${this._baseUrl}:8444/x-hls/${this.stream_cxid}/${roomId}/${this.stream_password}/${this.stream_vidctx}/${roomprefix}_${model.bestSession.phase}_${roomId}.m3u8`;
        }
        else {
            // standard-def wowza
            videoserv = `video${camserv - 500}`;
            return `https://${videoserv}.${this._baseUrl}:443/NxServer/ngrp:${roomprefix}_${roomId}.f4v_mobile/playlist.m3u8?nc=${Math.random().toString().replace("0.", "")}`;
        }
    }
    /**
     * Retrieves passcode for client
     * @returns A promise that resolves with a string containing client's passcode
     */
    getPassCode() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.password === "guest" || (this.password !== undefined && this.password.length === 32 && (/^[A-Za-z0-9]{32}$/).test(this.password) && !this._options.forceUnhashedPassword)) {
                // If password is 'guest' or we were given a pre-hashed passcode, just use that
                this._passcode_password = this.password;
                return this.password;
            }
            else if (typeof this._passcode === "string" && this.password === this._passcode_password) {
                // If we previously hashed this.password, and the password hasn't changed,
                // just re-use that
                return this._passcode;
            }
            else {
                // Otherwise we need to retrieve the passcode from the site
                this._passcode = undefined;
                this._passcode_password = this.password;
                const payload = {
                    submit_login: this.username.charCodeAt(0) || 2,
                    uid: Math.round(Math.random() * 99999999999999),
                    tz: -(new Date()).getTimezoneOffset() / 60,
                    ss: "1920x1080",
                    username: this.username,
                    password: this.password,
                };
                const cookieResponse = yield request({
                    method: "POST",
                    url: `https://www.${this._baseUrl}/php/login.php`,
                    form: payload,
                    transform: (body, response) => {
                        return { cookies: response.headers["set-cookie"], body };
                    },
                }).promise();
                if (Array.isArray(cookieResponse.cookies)) {
                    for (const cookie of cookieResponse.cookies) {
                        const match = (/^passcode=([A-Za-z0-9]{32});/).exec(cookie);
                        if (match !== null) {
                            this._passcode = match[1];
                            break;
                        }
                    }
                }
                if (this._passcode === undefined) {
                    const msg = `Failed to retrieve password hash for user '${this.username}' password '${this.password}'. Bad password?`;
                    Utils_1.logWithLevelInternal(Utils_1.LogLevel.ERROR, msg);
                    throw new Error(msg);
                }
                return this._passcode;
            }
            // Also, should I have a FCTYPE_SETPCODE hook? I'm not sure when they send that event...
        });
    }
}
Client._connectedClientCount = 0;
Client._initialReconnectSeconds = 6;
Client._reconnectBackOffMultiplier = 1.5;
Client._maximumReconnectSeconds = 1200; // 20 Minutes
Client._currentReconnectSeconds = 8;
Client.webSocketNoiseFilter = /^\d{4}\d+ \d+ \d+ \d+ \d+/;
exports.Client = Client;
//# sourceMappingURL=Client.js.map
