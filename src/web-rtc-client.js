// @flow
/* eslint-disable class-methods-use-this */
/* global window, document, navigator */
import 'webrtc-adapter';
import { SessionStatus } from 'sip.js/lib/Enums';
import { UA } from 'sip.js/lib/UA';
import { Utils } from 'sip.js/lib/Utils';
import { Exceptions } from 'sip.js/lib/Exceptions';
import { Modifiers } from 'sip.js/lib/Web';
import SIP from 'sip.js';
import Emitter from './utils/Emitter';

import once from './utils/once';
import Session from './domain/Session';
import ApiClient from './api-client';

import MobileSessionDescriptionHandler from './lib/MobileSessionDescriptionHandler';

const SIPMethods = { Web: { Modifiers }, Utils, Exceptions };

const MAX_REGISTER_TRY = 200;

const states = ['STATUS_NULL', 'STATUS_NEW', 'STATUS_CONNECTING', 'STATUS_CONNECTED', 'STATUS_COMPLETED'];
const events = [
  'registered',
  'unregistered',
  'registrationFailed',
  'invite',
  'inviteSent',
  'transportCreated',
  'newTransaction',
  'transactionDestroyed',
  'notify',
  'outOfDialogReferRequested',
  'message',
];
const transportEvents = [
  'connected',
  'disconnected',
  'transportError',
  'message',
  'closed',
  'keepAliveDebounceTimeout',
];
const MAX_MERGE_SESSIONS = 4;

type MediaConfig = {
  audio: Object & boolean,
  video: Object & boolean,
  localVideo?: Object & boolean,
};

type WebRtcConfig = {
  displayName: string,
  host: string,
  os: string,
  port?: number,
  authorizationUser: ?string,
  password: ?string,
  uri: string,
  media: MediaConfig,
  maxMergeSessions: number,
  iceCheckingTimeout: ?number,
  log?: Object,
  audioOutputDeviceId?: string,
};

// @see https://github.com/onsip/SIP.js/blob/master/src/Web/Simple.js
export default class WebRTCClient extends Emitter {
  config: WebRtcConfig;
  userAgent: UA;
  hasAudio: boolean;
  audio: Object | boolean;
  audioElements: { [string]: HTMLAudioElement };
  video: Object | boolean;
  videoEnabled: boolean;
  localVideo: ?Object & ?boolean;
  audioContext: ?AudioContext;
  audioStreams: Object;
  mergeDestination: ?MediaStreamAudioDestinationNode;
  audioOutputDeviceId: ?string;
  videoSessions: Object;
  registerTries: number;
  registered: boolean;
  registering: boolean;
  registerTimeout: ?TimeoutID;

  static isAPrivateIp(ip: string): boolean {
    const regex = /^(?:10|127|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\..*/;
    return regex.exec(ip) == null;
  }

  static getIceServers(ip: string): Array<{ urls: Array<string> }> {
    if (WebRTCClient.isAPrivateIp(ip)) {
      return [
        {
          urls: ['stun:stun.l.google.com:19302', 'stun:stun4.l.google.com:19302'],
        },
      ];
    }
    return [];
  }

  constructor(config: WebRtcConfig, session: ?Session) {
    super();
    this._buildConfig(config, session).then((newConfig: WebRtcConfig) => {
      this.config = newConfig;
      this.userAgent = this.createUserAgent();
    });

    this.audioOutputDeviceId = config.audioOutputDeviceId;

    this.configureMedia(config.media);

    this.videoSessions = {};
    this.registerTries = 0;
    this.registered = false;
    this.registerTimeout = null;
    this.registering = false;
  }

  configureMedia(media: MediaConfig) {
    this.hasAudio = !!media.audio;
    this.video = media.video;
    this.audio = media.audio;
    this.localVideo = media.localVideo;
    this.audioContext = this._isWeb() ? new (window.AudioContext || window.webkitAudioContext)() : null;
    this.audioStreams = {};
    this.audioElements = {};
  }

  createUserAgent(): UA {
    const webRTCConfiguration = this._createWebRTCConfiguration();
    const userAgent = new UA(webRTCConfiguration);

    events
      .filter(eventName => eventName !== 'invite' && eventName !== 'new')
      .forEach(eventName => userAgent.on(eventName, event => this.eventEmitter.emit(eventName, event)));

    // Particular case for `invite` event
    userAgent.on('invite', (session: SIP.sessionDescriptionHandler) => {
      this._setupSession(session);
      this._fixLocalDescription(session, 'answer');
      const shouldAutoAnswer = !!session.request.getHeader('alert-info');

      this.eventEmitter.emit('invite', session, this.sessionWantsToDoVideo(session), shouldAutoAnswer);
    });

    transportEvents.forEach(eventName => {
      userAgent.transport.on(eventName, event => {
        this.eventEmitter.emit(eventName, event);
      });
    });

    this._bindRegistrationEvents(userAgent);

    return userAgent;
  }

  isRegistered(): boolean {
    return this.userAgent && this.userAgent.isRegistered();
  }

  register() {
    if (!this.userAgent || this.isRegistered()) {
      return;
    }

    this.userAgent.register();
  }

  unregister() {
    if (!this.userAgent) {
      return;
    }

    this.userAgent.unregister();
    this.registered = false;
  }

  // eslint-disable-next-line no-unused-vars
  sessionWantsToDoVideo(session: SIP.sessionDescriptionHandler) {
    const sdp = session.request.body;
    const sessionHasVideo = /\r\nm=video /.test(sdp);

    return sessionHasVideo;
  }

  call(number: string, enableVideo?: boolean): SIP.InviteClientContext {
    this.changeVideo(enableVideo || false);
    const context = this.userAgent.invite(number, this._getMediaConfiguration(enableVideo || false));

    this._setupSession(context);

    return context;
  }

  answer(session: SIP.sessionDescriptionHandler, enableVideo?: boolean) {
    this.changeVideo(enableVideo || false);
    return session.accept(this._getMediaConfiguration(enableVideo || false));
  }

  hangup(session: SIP.sessionDescriptionHandler | SIP.InviteServerContext) {
    try {
      this._cleanupMedia(session);

      if (this.getSipSessionId(session) in this.audioStreams) {
        this.removeFromMerge(session);
      }

      this._cleanupMedia(session);

      // Check if sessionDescriptionHandler or InviteServerContext
      const isISC = typeof session.cancel !== 'undefined';

      const cancel = () => {
        if (isISC && !session.isCanceled) {
          session.cancel();
          // eslint-disable-next-line
        } else if(!session._canceled) {
          session.reject();
        }
      };

      const reject = () => session.reject && session.reject();

      const actions = {
        // Status 2: cancel
        [SessionStatus.STATUS_1XX_RECEIVED]: cancel,
        // Status 4: cancel
        [SessionStatus.STATUS_WAITING_FOR_ANSWER]: cancel,
        // Status 8: nothing to do
        [SessionStatus.STATUS_CANCELED]: null,
        // Status 9: nothing to do
        [SessionStatus.STATUS_TERMINATED]: null,
      };

      // Handle different session status
      if (actions[session.status]) {
        return actions[session.status]();
      }

      // For InviteServerContext
      if (isISC) {
        if (session.hasAnswer && session.bye) {
          return session.bye();
        }

        // For InviteServerContext
        if (!session.hasAnswer) {
          return cancel();
        }
      }

      if ('stop' in session) {
        session.stop();
      }

      return reject();
    } catch (error) {
      console.warn('WebRtcClient.hangup error', error);
    }

    return null;
  }

  reject(session: SIP.sessionDescriptionHandler) {
    return session.reject ? session.reject() : session.cancel();
  }

  getNumber(session: SIP.sessionDescriptionHandler): ?String {
    if (!session) {
      return null;
    }

    // eslint-disable-next-line
    return session.remoteIdentity.uri._normal.user;
  }

  mute(session: SIP.sessionDescriptionHandler) {
    this._toggleAudio(session, true);
  }

  unmute(session: SIP.sessionDescriptionHandler) {
    this._toggleAudio(session, false);
  }

  toggleCameraOn(session: SIP.sessionDescriptionHandler) {
    this._toggleVideo(session, false);
  }

  toggleCameraOff(session: SIP.sessionDescriptionHandler) {
    this._toggleVideo(session, true);
  }

  hold(session: SIP.sessionDescriptionHandler) {
    this.mute(session);

    return session.hold(this._getMediaConfiguration(this.videoEnabled));
  }

  unhold(session: SIP.sessionDescriptionHandler) {
    this.unmute(session);

    return session.unhold(this._getMediaConfiguration(this.videoEnabled));
  }

  sendDTMF(session: SIP.sessionDescriptionHandler, tone: string) {
    return session.dtmf(tone);
  }

  message(destination: string, message: string) {
    return this.userAgent.message(destination, message);
  }

  transfer(session: SIP.sessionDescriptionHandler, target: string) {
    this.hold(session);

    setTimeout(() => {
      session.refer(target);
      this.hangup(session);
    }, 50);
  }

  // check https://sipjs.com/api/0.12.0/refer/referClientContext/
  atxfer(session: SIP.sessionDescriptionHandler) {
    this.hold(session);

    return {
      init: (target: string) => this.call(target),
      complete: (newSession: SIP.sessionDescriptionHandler) => {
        this.unhold(session);

        setTimeout(() => {
          newSession.refer(session);
          this.hangup(session);
        }, 50);
      },
      cancel: (newSession: SIP.sessionDescriptionHandler) => {
        this.hangup(newSession);
        this.unhold(session);
      },
    };
  }

  merge(sessions: Array<SIP.InviteClientContext>): Array<Promise<boolean>> {
    this._checkMaxMergeSessions(sessions.length);
    if (this.audioContext) {
      this.mergeDestination = this.audioContext.createMediaStreamDestination();
    }

    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    return sessions.map(this.addToMerge.bind(this));
  }

  addToMerge(session: SIP.InviteClientContext): Promise<boolean> {
    this._checkMaxMergeSessions(Object.keys(this.audioStreams).length + 1);

    const isFirefox = this._isWeb() && navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    const sdh = session.sessionDescriptionHandler;
    const pc = sdh.peerConnection;

    const bindStreams = remoteStream => {
      const localStream = this._getLocalStream(pc);
      const localAudioSource = this._addAudioStream(localStream);
      const remoteAudioSource = this._addAudioStream(remoteStream);

      if (remoteStream) {
        pc.removeStream(remoteStream);
      }
      pc.removeStream(localStream);

      if (this.mergeDestination) {
        pc.addStream(this.mergeDestination.stream);
      }

      return pc.createOffer(this._getRtcOptions(false)).then(offer => {
        this.audioStreams[this.getSipSessionId(session)] = { localAudioSource, remoteAudioSource };

        pc.setLocalDescription(offer);
      });
    };

    if (session.localHold && !isFirefox) {
      this.unhold(session);

      // When call is hold we lost the current track. Wait for another one.
      return sdh.once('addTrack', e => bindStreams(e.streams[0]));
    }

    return bindStreams(this._getRemoteStream(pc));
  }

  removeFromMerge(session: SIP.InviteClientContext, shouldHold: boolean = true) {
    const sdh = session.sessionDescriptionHandler;
    const pc = sdh.peerConnection;
    const { localAudioSource, remoteAudioSource } = this.audioStreams[this.getSipSessionId(session)];

    if (remoteAudioSource) {
      remoteAudioSource.disconnect(this.mergeDestination);
    }
    localAudioSource.disconnect(this.mergeDestination);

    if (this.audioContext) {
      const newDestination = this.audioContext.createMediaStreamDestination();
      localAudioSource.connect(newDestination);
      if (remoteAudioSource) {
        remoteAudioSource.connect(newDestination);
      }

      if (pc.signalingState === 'closed' || pc.iceConnectionState === 'closed') {
        return null;
      }

      if (this.mergeDestination && this.mergeDestination.stream) {
        pc.removeStream(this.mergeDestination.stream);
      }
      pc.addStream(newDestination.stream);
    }

    delete this.audioStreams[this.getSipSessionId(session)];

    return pc.createOffer(this._getRtcOptions(false)).then(offer => {
      const result = pc.setLocalDescription(offer);

      if (shouldHold) {
        this.hold(session);
      }

      return result;
    });
  }

  unmerge(sessions: Array<SIP.InviteClientContext>): Promise<boolean> {
    const nbSessions = sessions.length;

    const promises = sessions.map((session, i) => this.removeFromMerge(session, i < nbSessions - 1));

    return new Promise((resolve, reject) => {
      Promise.all(promises)
        .then(() => {
          this.mergeDestination = null;
          resolve(true);
        })
        .catch(reject);
    });
  }

  getState() {
    return states[this.userAgent.state];
  }

  getContactIdentifier() {
    return this.userAgent ? `${this.userAgent.configuration.contactName}/${this.userAgent.contact.uri}` : null;
  }

  close() {
    this._cleanupMedia();

    (Object.values(this.audioElements): any).forEach((audioElement: HTMLAudioElement) => {
      // eslint-disable-next-line
      audioElement.srcObject = null;
      audioElement.pause();
    });

    this.audioElements = {};
    if (!this.userAgent) {
      return null;
    }

    if (this.userAgent.transport) {
      this.userAgent.transport.disconnect();
    }

    this.userAgent.removeAllListeners();

    // Clear sessions correctly, avoid to call `terminate` on them in `userAgent.stop` later
    Object.keys(this.userAgent.sessions).forEach(sessionId => {
      this.hangup(this.userAgent.sessions[sessionId]);
      delete this.userAgent.sessions[sessionId];
    });

    return this.userAgent.stop();
  }

  changeAudioOutputDevice(id: string) {
    Object.values(this.audioElements).forEach(audioElement => {
      // `setSinkId` method is not included in any flow type definitions for HTMLAudioElements but is a valid method
      // audioElement is an array of HTMLAudioElements, and HTMLAudioElement inherits the method from HTMLMediaElement
      // https://developer.mozilla.org/en-US/docs/Web/API/HTMLAudioElement
      // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId

      // $FlowFixMe
      if (audioElement.setSinkId) {
        audioElement.setSinkId(id);
      }
    });
  }

  changeAudioInputDevice(id: string) {
    this.audio = id ? { deviceId: { exact: id } } : true;
    if (this.userAgent) {
      this.userAgent.transport.disconnect();
      this.userAgent.stop();
      this.userAgent.removeAllListeners();
    }
    this.userAgent = this.createUserAgent();
  }

  changeVideoInputDevice(id: string) {
    this.video = id ? { deviceId: { exact: id } } : true;
    if (this.userAgent) {
      this.userAgent.transport.disconnect();
      this.userAgent.removeAllListeners();
      this.userAgent.stop();
    }
    this.userAgent = this.createUserAgent();
  }

  changeVideo(enabled: boolean) {
    this.videoEnabled = enabled;
  }

  _checkMaxMergeSessions(nbSessions: number) {
    if (nbSessions < MAX_MERGE_SESSIONS) {
      return;
    }

    console.warn(
      `Merging more than ${MAX_MERGE_SESSIONS} session is not recommended, it will consume too many resources.`,
    );
  }

  _fixLocalDescription(context: SIP.InviteClientContext, direction: string) {
    const eventName = direction === 'answer' ? 'iceGatheringComplete' : 'iceCandidate';
    context.on(
      'SessionDescriptionHandler-created',
      once(sdh => {
        sdh.on(
          eventName,
          once(() => {
            const pc = sdh.peerConnection;
            const constraints = this._getRtcOptions(this._hasVideo());
            pc.createOffer(constraints).then(offer => pc.setLocalDescription(offer));
          }),
        );
      }),
    );
  }

  _isWeb() {
    return typeof window === 'object' && typeof document === 'object';
  }

  _hasAudio() {
    return this.hasAudio;
  }

  _getAudioConstraints() {
    return this.audio && this.audio.deviceId && this.audio.deviceId.exact ? this.audio : true;
  }

  _getVideoConstraints() {
    if (!this.videoEnabled) {
      return false;
    }
    return this.video && this.video.deviceId && this.video.deviceId.exact ? this.video : true;
  }

  _hasVideo() {
    return this.videoEnabled;
  }

  sessionHasLocalVideo(sessionId: string): boolean {
    const streams = this.videoSessions[sessionId];
    if (!streams || !streams.local) {
      return false;
    }
    return !!streams.local.getVideoTracks().length;
  }

  sessionHasRemoteVideo(sessionId: string): boolean {
    const streams = this.videoSessions[sessionId];
    if (!streams || !streams.remotes) {
      return false;
    }
    return streams.remotes.some(remote => !!remote.getVideoTracks().length);
  }

  sessionHasVideo(sessionId: string) {
    return this.sessionHasLocalVideo(sessionId) || this.sessionHasRemoteVideo(sessionId);
  }

  sessionHasAudio(session: SIP.sessionDescriptionHandler) {
    const pc = session.sessionDescriptionHandler.peerConnection;

    if (pc.getSenders) {
      const senders = pc.getSenders();

      return senders.some(sender => sender.track && sender.track.kind === 'audio' && sender.track.enabled);
    }

    const localStreams = this._getLocalStream(pc);

    return localStreams.some(stream => {
      const audioTracks = stream.getAudioTracks();
      return audioTracks.some(track => track.kind === 'audio' && track.enabled);
    });
  }

  getRemoteVideoStreamsForSession(sessionId: string) {
    const streams = this.videoSessions[sessionId];
    if (!streams || !streams.remotes) {
      return [];
    }
    return streams.remotes;
  }

  reinit(cb: Function = () => {}) {
    if (this.registering) {
      return;
    }

    this.registering = true;
    this.registerTries = 0;
    this.registered = false;
    this._tryToRegister(cb);
  }

  getSipSessionId(sipSession: ?SIP.sessionDescriptionHandler): string {
    return (sipSession && sipSession.request && sipSession.request.callId) || (sipSession && sipSession.id) || '';
  }

  _initializeVideoSession(sessionId: string) {
    if (!this.videoSessions[sessionId]) {
      this.videoSessions[sessionId] = {
        local: null,
        remotes: [],
      };
    }
  }

  _buildConfig(config: WebRtcConfig, session: ?Session): Promise<WebRtcConfig> {
    // If no session provided, return the configuration directly
    if (!session) {
      return new Promise(resolve => resolve(config));
    }

    const client = new ApiClient({ server: config.host });

    return client.confd.getUserLineSipFromToken(session.token, session.uuid).then(sipLine => ({
      authorizationUser: sipLine.username,
      password: sipLine.secret,
      uri: `${sipLine.username}@${config.host}`,
      ...config,
    }));
  }

  _addLocalToVideoSession(sessionId: string, stream: any) {
    this._initializeVideoSession(sessionId);

    this.videoSessions[sessionId].local = stream;
  }

  _addRemoteToVideoSession(sessionId: string, stream: any) {
    this._initializeVideoSession(sessionId);

    this.videoSessions[sessionId].remotes.push(stream);
  }

  _hasLocalVideo() {
    return !!this.localVideo;
  }

  _createWebRTCConfiguration() {
    const config: Object = {
      authorizationUser: this.config.authorizationUser,
      displayName: this.config.displayName,
      hackIpInContact: true,
      hackWssInTransport: true,
      log: this.config.log || { builtinEnabled: false },
      password: this.config.password,
      uri: `${this.config.authorizationUser || ''}@${this.config.host}`,
      transportOptions: {
        traceSip: false,
        wsServers: `wss://${this.config.host}:${this.config.port || 443}/api/asterisk/ws`,
      },
      sessionDescriptionHandlerFactoryOptions: {
        constraints: {
          audio: this._getAudioConstraints(),
          video: this._getVideoConstraints(),
        },
        peerConnectionOptions: {
          iceCheckingTimeout: this.config.iceCheckingTimeout || 5000,
          rtcConfiguration: {
            rtcpMuxPolicy: 'require',
            bundlePolicy: 'max-compat',
            iceServers: WebRTCClient.getIceServers(this.config.host),
            ...this._getRtcOptions(this.videoEnabled),
          },
        },
      },
    };

    // Use custom SessionDescription handler for mobile
    if (!this._isWeb()) {
      config.sessionDescriptionHandlerFactory = MobileSessionDescriptionHandler(SIPMethods).defaultFactory;
      config.registerOptions = {
        extraContactHeaderParams: ['mobility=mobile'],
      };
    }

    return config;
  }

  // eslint-disable-next-line no-unused-vars
  _getRtcOptions(enableVideo: boolean) {
    return {
      mandatory: {
        OfferToReceiveAudio: this._hasAudio(),
        OfferToReceiveVideo: enableVideo,
      },
    };
  }

  _getMediaConfiguration(enableVideo: boolean) {
    return {
      sessionDescriptionHandlerOptions: {
        constraints: {
          audio: this._getAudioConstraints(),
          video: this._getVideoConstraints(),
        },
        disableVideo: !enableVideo,
        RTCOfferOptions: {
          OfferToReceiveAudio: this._hasAudio(),
          OfferToReceiveVideo: enableVideo,
          mandatory: {
            OfferToReceiveAudio: this._hasAudio(),
            OfferToReceiveVideo: enableVideo,
          },
        },
      },
    };
  }

  _setupSession(session: SIP.sessionDescriptionHandler) {
    session.on('accepted', () => this._onAccepted(session));

    session.on('terminated', () => {
      if ('stop' in session) {
        session.stop();
      }

      if (this.getSipSessionId(session) in this.audioStreams) {
        this.removeFromMerge(session);
      }
    });

    session.on('SessionDescriptionHandler-created', sdh => {
      sdh.on('userMedia', stream => {
        // eslint-disable-next-line
        session.stop = () => {
          stream.getAudioTracks().forEach(track => {
            track.stop();
          });
        };
      });
    });
  }

  _onAccepted(session: SIP.sessionDescriptionHandler) {
    this._setupLocalMedia(session);
    this._setupRemoteMedia(session);

    session.sessionDescriptionHandler.on('addTrack', () => {
      this._setupRemoteMedia(session);
    });

    session.sessionDescriptionHandler.on('addStream', () => {
      this._setupRemoteMedia(session);
    });

    this.eventEmitter.emit('accepted', session);
  }

  _setupRemoteMedia(session: SIP.sessionDescriptionHandler) {
    // If there is a video track, it will attach the video and audio to the same element
    const pc = session.sessionDescriptionHandler.peerConnection;
    const remoteStream = this._getRemoteStream(pc);

    if (this._hasVideo() && this._isWeb()) {
      this._addRemoteToVideoSession(this.getSipSessionId(session), remoteStream);
    } else if (this._hasAudio() && this._isWeb()) {
      const audio = this.audioElements[this.getSipSessionId(session)];
      audio.srcObject = remoteStream;
      audio.play();
    }
  }

  _addAudioStream(mediaStream: MediaStream) {
    if (!this.audioContext || !mediaStream) {
      return null;
    }
    const audioSource = this.audioContext.createMediaStreamSource(mediaStream);
    if (this.mergeDestination) {
      audioSource.connect(this.mergeDestination);
    }

    return audioSource;
  }

  _setupLocalMedia(session: SIP.sessionDescriptionHandler) {
    // Safari hack, because you cannot call .play() from a non user action
    if (this._hasAudio() && this._isWeb()) {
      const audio: any = document.createElement('audio');

      if (audio.setSinkId && this.audioOutputDeviceId) {
        audio.setSinkId(this.audioOutputDeviceId);
      }

      if (document.body) {
        document.body.appendChild(audio);
      }
      this.audioElements[this.getSipSessionId(session)] = audio;
    }

    if (!this._hasVideo()) {
      return;
    }

    const pc = session.sessionDescriptionHandler.peerConnection;
    const localStream = this._getLocalStream(pc);

    if (this._isWeb() && this._hasVideo()) {
      this._addLocalToVideoSession(this.getSipSessionId(session), localStream);
    }
  }

  _cleanupMedia(session: ?SIP.sessionDescriptionHandler) {
    const sessionId = this.getSipSessionId(session);
    if (session && sessionId in this.videoSessions) {
      delete this.videoSessions[this.getSipSessionId(session)];
    }

    const cleanAudio = id => {
      const element = this.audioElements[id];

      element.pause();
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
      element.srcObject = null;

      delete this.audioElements[id];
    };

    if (this._hasAudio() && this._isWeb()) {
      if (session) {
        cleanAudio(this.getSipSessionId(session));
      } else {
        Object.keys(this.audioElements).forEach(id => cleanAudio(id));
      }
    }
  }

  _toggleAudio(session: SIP.sessionDescriptionHandler, muteAudio: boolean) {
    const pc = session.sessionDescriptionHandler ? session.sessionDescriptionHandler.peerConnection : null;
    if (!pc) {
      return;
    }

    if (pc.getSenders) {
      pc.getSenders().forEach(sender => {
        if (sender.track && sender.track.kind === 'audio') {
          // eslint-disable-next-line
          sender.track.enabled = !muteAudio;
        }
      });
    } else {
      pc.getLocalStreams().forEach(stream => {
        stream.getAudioTracks().forEach(track => {
          // eslint-disable-next-line
          track.enabled = !muteAudio;
        });
      });
    }
  }

  _toggleVideo(session: SIP.sessionDescriptionHandler, muteCamera: boolean) {
    const pc = session.sessionDescriptionHandler.peerConnection;

    if (pc.getSenders) {
      pc.getSenders().forEach(sender => {
        if (sender.track && sender.track.kind === 'video') {
          // eslint-disable-next-line
          sender.track.enabled = !muteCamera;
        }
      });
    } else {
      pc.getLocalStreams().forEach(stream => {
        stream.getVideoTracks().forEach(track => {
          // eslint-disable-next-line
          track.enabled = !muteCamera;
        });
      });
    }
  }

  _bindRegistrationEvents(userAgent: UA) {
    const onDisconnected = () => {
      this.registered = false;
      this.reinit();
    };

    userAgent.on('registered', () => {
      this.registered = true;
    });

    userAgent.transport.on('disconnected', onDisconnected);
    userAgent.on('unregistered', onDisconnected);
  }

  _tryToRegister(cb: Function = () => {}) {
    if (this.registered || this.registerTries >= MAX_REGISTER_TRY) {
      if (this.registerTimeout) {
        clearTimeout(this.registerTimeout);
      }
      cb(this.registerTries >= MAX_REGISTER_TRY);
      this.registering = false;
      return;
    }

    this.registerTimeout = setTimeout(() => {
      if (this.userAgent) {
        this.userAgent.removeAllListeners();
      }
      this.userAgent = this.createUserAgent();

      this.register();
      this.registerTries++;
      this._tryToRegister(cb);
    }, 1500 * this.registerTries);
  }

  /**
   * @param pc RTCPeerConnection
   */
  _getRemoteStream(pc: any) {
    let remoteStream;

    if (pc.getReceivers) {
      remoteStream = typeof global !== 'undefined' ? new global.window.MediaStream() : new window.MediaStream();
      pc.getReceivers().forEach(receiver => {
        const { track } = receiver;
        if (track) {
          remoteStream.addTrack(track);
        }
      });
    } else {
      [remoteStream] = pc.getRemoteStreams();
    }

    return remoteStream;
  }

  /**
   * @param pc RTCPeerConnection
   */
  _getLocalStream(pc: any) {
    let localStream;

    if (pc.getSenders) {
      localStream = typeof global !== 'undefined' ? new global.window.MediaStream() : new window.MediaStream();
      pc.getSenders().forEach(sender => {
        const { track } = sender;
        if (track) {
          localStream.addTrack(track);
        }
      });
    } else {
      [localStream] = pc.getLocalStreams();
    }

    return localStream;
  }
}
