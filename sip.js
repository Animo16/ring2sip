import sipLib from 'sip'
import digest from 'sip/digest.js'
import { RtpPacket } from 'werift'
import { EventEmitter } from 'events'
import { createSocket } from "dgram";
import RtpSequencer from './rtp-sequencer.js'

const {
  SIP_DOMAIN,
  SIP_PORT,
  SIP_DEST,
  SIP_USER,
  SIP_PASS,
  LOCAL_IP,
  LOCAL_RTP_PORT,
  LOCAL_SIP_PORT
} = process.env

const LOCAL_VIDEO_PORT = parseInt(LOCAL_RTP_PORT) + 2

function rstring() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 9; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

class Sip extends EventEmitter {
  constructor() {
    super()
    this.sipSession = null
    this.inviteRequest = null
    this.authSession = { realm: SIP_DOMAIN }
    this.isSipStackStarted = false
    this.initiatingCall = false
    this.serverRtpInfo = null
    this.udp = createSocket('udp4');
    this.udp.bind(LOCAL_RTP_PORT, LOCAL_IP, () => {
      console.log(`SIP - Audio RTP Socket bound to ${LOCAL_IP}:${LOCAL_RTP_PORT}`);
    })
    this.udpVideo = createSocket('udp4');
    this.udpVideo.bind(LOCAL_VIDEO_PORT, LOCAL_IP, () => {
      console.log(`SIP - Video RTP Socket bound to ${LOCAL_IP}:${LOCAL_VIDEO_PORT}`);
    })
    this.rtpSequencer = new RtpSequencer()

    this.registerInterval = null
    this.registerExpires = 600 // seconds (example)
    this.currentCallId = null  // track inbound calls or single call scenario
  }

  //--------------------------------------------------------------------------
  // Public Methods
  //--------------------------------------------------------------------------

  initialize(debug = false) {
    if (this.isSipStackStarted) return

    sipLib.start({
      address: LOCAL_IP,
      port: LOCAL_SIP_PORT,
      logger: debug ? {
        send: function (m, target) { console.log('send', m) },
        recv: function (m, target) { console.log('recv', m) },
        error: function (e) { console.log('error', e) }
      } : null
    }, (request) => {
      console.log(`SIP - Received request: ${request.method}`)

      if (request.method === 'BYE') {
        this._handleBye(request)
      }
      else if (request.method === 'INVITE') {
        this._handleInboundInvite(request)
      }
      else if (request.method === 'OPTIONS') {
        const response = sipLib.makeResponse(request, 200, 'OK')
        sipLib.send(response)
      }
    })

    this.isSipStackStarted = true

    return Promise.resolve()
  }

  register() {
    if (this.registerInterval) {
      // Already registering/registered
      return
    }

    const sendRegister = (expires = this.registerExpires) => {
      const callId = rstring()
      const registerRequest = {
        method: 'REGISTER',
        uri: `sip:${SIP_DOMAIN}`,
        headers: {
          to: { uri: `sip:${SIP_USER}@${SIP_DOMAIN}` },
          from: {
            uri: `sip:${SIP_USER}@${SIP_DOMAIN}`,
            params: { tag: rstring() }
          },
          'call-id': callId,
          cseq: { method: 'REGISTER', seq: 1 },
          contact: [{
            uri: `sip:${SIP_USER}@${LOCAL_IP}:${LOCAL_SIP_PORT}`,
            params: { expires }
          }],
          'max-forwards': 70,
          'user-agent': 'SipToRing/1.0',
          'Expires': expires
        }
      }

      sipLib.send(registerRequest, (response) => {
        if (response.status === 401 && response.headers['www-authenticate']) {
          this._retryWithDigestAuth(
            registerRequest,
            response,
            'SIP - REGISTER success (after auth).',
            'SIP - REGISTER failed:',
            () => { }
          )
        }
        else if (response.status >= 200 && response.status < 300) {
          console.log('SIP - REGISTER success.')
        }
        else {
          console.error(`SIP - REGISTER failed: ${response.status} ${response.reason}`)
        }
      })
    }

    // Immediately send a REGISTER
    sendRegister(this.registerExpires)

    // Keep re-registering every <registerExpires> seconds
    this.registerInterval = setInterval(() => {
      sendRegister(this.registerExpires)
    }, this.registerExpires * 1000)
  }

  initiateCall() {
    if (this.initiatingCall) return
    this.initiatingCall = true

    console.log(`SIP - Initiating call to extension ${SIP_DEST} on ${SIP_DOMAIN}...`)

    const sessionId = Date.now()
    this.inviteRequest = {
      method: 'INVITE',
      uri: `sip:${SIP_DEST}@${SIP_DOMAIN}`,
      headers: {
        to: { uri: `sip:${SIP_DEST}@${SIP_DOMAIN}` },
        from: {
          uri: `sip:${SIP_USER}@${SIP_DOMAIN}`,
          params: { tag: rstring() }
        },
        'call-id': rstring(),
        cseq: { method: 'INVITE', seq: 1 },
        contact: [{ uri: `sip:${SIP_USER}@${LOCAL_IP}:${LOCAL_SIP_PORT}` }],
        'max-forwards': 70,
        'content-type': 'application/sdp'
      },
      content: this._buildLocalSdp(sessionId)
    }

    sipLib.send(this.inviteRequest, (response) => {
      this._handleInviteResponse(response)
    })
  }

  cleanup() {
    // If there's a live call, send BYE
    if (this.sipSession && this.sipSession.headers) {
      console.log('SIP - Sending BYE to terminate call...')
      const response = this.sipSession
      const request = {
        method: 'BYE',
        uri: response.headers.contact[0].uri,
        headers: {
          to: response.headers.to,
          from: response.headers.from,
          'call-id': response.headers['call-id'],
          cseq: { method: 'BYE', seq: response.headers.cseq.seq + 1 },
          via: response.headers.via
        }
      }
      sipLib.send(request)
    }
    // If we have an INVITE in progress, send CANCEL
    else if (this.inviteRequest) {
      console.log('SIP - Sending CANCEL to terminate call...')
      const response = this.inviteRequest
      const request = {
        method: 'CANCEL',
        uri: response.uri,
        headers: {
          to: response.headers.to,
          from: response.headers.from,
          'call-id': response.headers['call-id'],
          cseq: { method: 'CANCEL', seq: response.headers.cseq.seq + 1 },
          via: response.headers.via
        }
      }
      sipLib.send(request)
    }

    // Unregister (send REGISTER with Expires=0)
    if (this.registerInterval) {
      clearInterval(this.registerInterval)
      this.registerInterval = null

      // Optional: Send a REGISTER to remove our contact
      const unregisterRequest = {
        method: 'REGISTER',
        uri: `sip:${SIP_DOMAIN}`,
        headers: {
          to: { uri: `sip:${SIP_USER}@${SIP_DOMAIN}` },
          from: {
            uri: `sip:${SIP_USER}@${SIP_DOMAIN}`,
            params: { tag: rstring() }
          },
          'call-id': rstring(),
          cseq: { method: 'REGISTER', seq: 1 },
          contact: [{
            uri: `sip:${SIP_USER}@${LOCAL_IP}:${LOCAL_SIP_PORT}`,
            params: { expires: 0 }
          }],
          'max-forwards': 70,
          'Expires': 0
        }
      }

      const sendUnregister = (req) => {
        sipLib.send(req, (response) => {
          if (response.status === 401 && response.headers['www-authenticate']) {
            console.log('SIP - Unregister unauthorized. Retrying with Digest Authentication...')
            this._retryWithDigestAuth(
              req,
              response,
              'SIP - Unregister success (after auth).',
              'SIP - Unregister failed:',
              () => { }
            )
          } else if (response.status >= 200 && response.status < 300) {
            console.log('SIP - Unregister success.')
          } else {
            console.error(`SIP - Unregister failed: ${response.status} ${response.reason}`)
          }
        })
      }

      sendUnregister(unregisterRequest)
    }

    // Close the UDP socket
    if (this.udp) {
      this.udp.close()
      this.udp = null
    }
    if (this.udpVideo) {
      this.udpVideo.close()
      this.udpVideo = null
    }
    this.sipSession = null
    this.inviteRequest = null
  }

  pipeAudio(ring) {
    this.udp.on('message', (message) => {
      const rtpPacket = RtpPacket.deSerialize(message)
      ring.sendAudioPacket(rtpPacket, false)
    })
  }

  sendAudioPacket(rtp, isTone = false) {
    if (!this.serverRtpInfo || !this.serverRtpInfo.audio) return

    // Use RtpSequencer to decide if we drop or forward
    const shouldForward = this.rtpSequencer.process(rtp, isTone)
    if (!shouldForward) return

    rtp.header.payloadType = this.serverRtpInfo.audio.payloadType
    this.udp.send(rtp.serialize(), this.serverRtpInfo.audio.port, this.serverRtpInfo.audio.destination)
  }

  sendVideoPacket(rtp) {
    if (!this.serverRtpInfo || !this.serverRtpInfo.video) return

    rtp.header.payloadType = this.serverRtpInfo.video.payloadType
    // Video doesn't use the sequencer logic usually, just forward
    this.udpVideo.send(rtp.serialize(), this.serverRtpInfo.video.port, this.serverRtpInfo.video.destination)
  }

  //--------------------------------------------------------------------------
  // Internal Helpers
  //--------------------------------------------------------------------------

  /**
   * Centralized method to handle 401 + Digest Authentication
   */
  _retryWithDigestAuth(request, response, successLog, errorLog, callback) {
    console.log('SIP - Unauthorized (401). Retrying with Digest Authentication...')
    digest.signRequest(this.authSession, request, response, {
      user: SIP_USER,
      password: SIP_PASS
    })
    request.headers.cseq.seq += 1

    sipLib.send(request, (authResp) => {
      if (authResp.status >= 100 && authResp.status < 300) {
        console.log(successLog)
      } else {
        console.error(`${errorLog} ${authResp.status} ${authResp.reason}`)
      }
      callback(authResp)
    })
  }

  _handleBye(request) {
    const ourCallId = this.sipSession?.headers['call-id']
    const receivedCallId = request.headers['call-id']

    sipLib.send(sipLib.makeResponse(request, 200, 'OK'))

    if (ourCallId && receivedCallId && ourCallId === receivedCallId) {
      console.log('SIP - Received BYE for our call. Sending 200 OK, ending call.')
      this.sipSession = null
      this.emit('callEnded')
    } else {
      console.log('SIP - Received BYE with mismatched or missing call-id. Ignoring.')
    }
  }

  /**
   * Handle inbound INVITE. We'll auto-answer only if OPUS is offered.
   * If OPUS is not found, reject with 488 Not Acceptable Here.
   */
  _handleInboundInvite(request) {
    if (this.initiatingCall) return
    this.initiatingCall = true

    console.log('SIP - Inbound call, checking offered codecs...')

    // Keep track of this call to handle BYE properly
    this.currentCallId = request.headers['call-id']

    // Parse the remote SDP
    const remoteSdp = request.content || ''
    const remoteInfo = this._parseRemoteSdp(remoteSdp)

    if (!remoteInfo || !remoteInfo.audio) {
      // No OPUS found, reject
      console.log('SIP - Remote did not offer OPUS. Rejecting call.')
      const response = sipLib.makeResponse(request, 488, 'Not Acceptable Here')
      sipLib.send(response)
      return
    }

    // Store the server RTP info so we can send audio to them
    this.serverRtpInfo = remoteInfo

    // Send 100 Trying
    sipLib.send(sipLib.makeResponse(request, 100, 'Trying'))

    this.emit('inboundCall')

    // Optional: Send 180 Ringing if you want to simulate "ringing"
    sipLib.send(sipLib.makeResponse(request, 180, 'Ringing'))

    console.log('SIP - Offering 200 OK with local OPUS SDP...')

    // Build 200 OK with local SDP
    const sessionId = Date.now()
    const okResponse = sipLib.makeResponse(request, 200, 'OK')
    okResponse.headers['content-type'] = 'application/sdp'
    okResponse.content = this._buildLocalSdp(sessionId)

    sipLib.send(okResponse)

    this.sipSession = okResponse

    // The inbound call is now "established" from our perspective
    // (SIP library will handle the ACK check behind the scenes)

    this.emit('callEstablished', this.serverRtpInfo)
  }

  _handleInviteResponse(response) {
    if (!this.inviteRequest) return

    // 401 => unauthorized, re-send with Digest
    if (response.status === 401 && response.headers['www-authenticate']) {
      this._retryWithDigestAuth(
        this.inviteRequest,
        response,
        'SIP - INVITE success (after auth).',
        'SIP - INVITE failed:',
        (authResp) => this._handleInviteResponse(authResp)
      )
      return
    }
    else if (response.status >= 100 && response.status < 200) {
      // Provisional responses
      if (response.status === 180) {
        this.emit('ringing')
      }
    }
    else if (response.status >= 200 && response.status < 300) {
      console.log(`SIP - Call established: ${response.status} ${response.reason}`)
      this.sipSession = response

      // Parse SDP from the response
      this.serverRtpInfo = this._parseRemoteSdp(response.content)

      // Send ACK
      sipLib.send({
        method: 'ACK',
        uri: response.headers.contact[0].uri,
        headers: {
          to: response.headers.to,
          from: response.headers.from,
          'call-id': response.headers['call-id'],
          cseq: { method: 'ACK', seq: response.headers.cseq.seq },
          via: response.headers.via
        }
      })

      // Let others know we've established the call
      this.emit('callEstablished', this.serverRtpInfo)
    }
    else {
      console.error(`SIP - Call failed: ${response.status} ${response.reason}`, response)
      this.inviteRequest = null
      this.emit('callFailed', { status: response.status, reason: response.reason })
    }
  }

  /**
   * Parse the remote SDP, find if OPUS/H264 is offered.
   */
  _parseRemoteSdp(sdp) {
    if (!sdp) return null

    const lines = sdp.split('\n').map(l => l.trim())
    const result = { audio: null, video: null }

    // --- AUDIO (OPUS) ---
    const mAudioLine = lines.find(line => line.startsWith('m=audio'))
    if (mAudioLine) {
      const match = mAudioLine.match(/m=audio\s+(\d+)\s+RTP\/\S+\s+(.+)/)
      if (match) {
        const port = parseInt(match[1], 10)
        const payloadTypes = match[2].split(' ').map(n => parseInt(n, 10))

        // Get Audio Destination
        let destination = '127.0.0.1'
        const cLine = lines.find(line => line.startsWith('c=IN IP4'))
        if (cLine) {
          const cMatch = cLine.match(/c=IN IP4\s+(\S+)/)
          if (cMatch) destination = cMatch[1]
        }

        // Search for OPUS
        let opusPayloadType = null
        lines.forEach(line => {
          if (line.startsWith('a=rtpmap:')) {
            const rtpmapMatch = line.match(/a=rtpmap:(\d+)\s+([\w\-]+)/)
            if (!rtpmapMatch) return
            const pt = parseInt(rtpmapMatch[1], 10)
            const codec = rtpmapMatch[2].toUpperCase()
            if (codec.includes('OPUS') && payloadTypes.includes(pt)) {
              opusPayloadType = pt
            }
          }
        })

        if (opusPayloadType) {
          console.log(`SIP - Found Remote Audio: ${destination}:${port} PT=${opusPayloadType}`)
          result.audio = { destination, port, payloadType: opusPayloadType }
        }
      }
    }

    // --- VIDEO (H264) ---
    const mVideoLine = lines.find(line => line.startsWith('m=video'))
    if (mVideoLine) {
      const match = mVideoLine.match(/m=video\s+(\d+)\s+RTP\/\S+\s+(.+)/)
      if (match) {
        const port = parseInt(match[1], 10)
        const payloadTypes = match[2].split(' ').map(n => parseInt(n, 10))

        // Video destination might be same as global c= or specific
        // For simplicity assume same global c= unless m=video has its own (not implemented deeply here)
        // But let's check if there is a c= line after m=video? 
        // Standard SDP parsing is complex. We'll use the one we found earlier or look for one specifically for video?
        // Simpler approach: Use the global c= line we found (destination var).
        const destination = result.audio ? result.audio.destination : '127.0.0.1'

        let h264PayloadType = null
        lines.forEach(line => {
          if (line.startsWith('a=rtpmap:')) {
            const rtpmapMatch = line.match(/a=rtpmap:(\d+)\s+([\w\-]+)/)
            if (!rtpmapMatch) return
            const pt = parseInt(rtpmapMatch[1], 10)
            const codec = rtpmapMatch[2].toUpperCase()
            if (codec.includes('H264') && payloadTypes.includes(pt)) {
              h264PayloadType = pt
            }
          }
        })

        if (h264PayloadType) {
          console.log(`SIP - Found Remote Video: ${destination}:${port} PT=${h264PayloadType}`)
          result.video = { destination, port, payloadType: h264PayloadType }
        }
      }
    }

    return (result.audio || result.video) ? result : null
  }

  _buildLocalSdp(sessionId) {
    return [
      'v=0',
      `o=- ${sessionId} ${sessionId} IN IP4 ${LOCAL_IP}`,
      's=-',
      `c=IN IP4 ${LOCAL_IP}`,
      't=0 0',
      'm=audio 8000 RTP/AVP 96',
      'a=rtpmap:96 OPUS/48000/2',
      'a=fmtp:96 useinbandfec=1;minptime=10',
      'a=ptime:20',
      'a=maxptime:150',
      'a=sendrecv',
      'm=video ' + LOCAL_VIDEO_PORT + ' RTP/AVP 99',
      'a=rtpmap:99 H264/90000',
      'a=fmtp:99 packetization-mode=1;profile-level-id=42e01f',
      'a=sendonly',
    ].join('\r\n') + '\r\n';
  }
}

export const sip = new Sip()

