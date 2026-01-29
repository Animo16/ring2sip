import { RingApi } from 'ring-client-api'
import { EventEmitter } from 'events'
import { getRefreshTokenFromEnv, updateRefreshTokenInEnv } from './util.js'
import RtpSequencer from './rtp-sequencer.js'

const {
  CAMERA_NAME
} = process.env

class Ring extends EventEmitter {
  constructor() {
    super()
    this.ringApi = null
    this.currentCall = null
    this.camera = null
    this.sip = null
    this.initiatingCall = false
    this.receivingAudio = false
    this.rtpSequencer = new RtpSequencer()
  }

  // 1) Initialize the Ring API
  initialize() {
    return new Promise((resolve, reject) => {
      const refreshToken = getRefreshTokenFromEnv()
      this.ringApi = new RingApi({ refreshToken, debug: true })

      this.ringApi.onRefreshTokenUpdated.subscribe(async ({ newRefreshToken }) => {
        console.log('RING - Refresh token updated')
        updateRefreshTokenInEnv(newRefreshToken)
      })

      // onActiveDings is not available on the main API instance in this version
      // We use camera-level subscriptions instead.

      this.ringApi.getCameras().then((cameras) => {
        if (!cameras.length) {
          return reject(new Error('No cameras found in the location.'))
        }

        for (let camera of cameras) {
          if (camera.isDoorbot && camera.name == CAMERA_NAME) {
            this.camera = camera
            console.log(`Attaching button listener to ${camera.name}`)

            // Check for active dings (this might work during calls)
            if (this.camera.onActiveNotifications) {
              this.camera.onActiveNotifications.subscribe((dings) => {
                const ring = dings.find(d => d.kind === 'ding' && d.state === 'ringing')
                if (ring) {
                  console.log('RING - ActiveNotification detected (ding)!')
                  this.emit('buttonPressed', this.camera)
                }
              })
            }

            if (this.camera.onNewNotification) {
              this.camera.onNewNotification.subscribe((notification) => {
                // console.log(`RING - onNewNotification fired:`, JSON.stringify(notification))

                let isDing = false
                let dingId = null

                // Check V2 notification structure (subtype is button_press)
                if (notification.data && notification.data.event && notification.data.event.ding) {
                  if (notification.data.event.ding.subtype === 'button_press') {
                    isDing = true
                    dingId = notification.data.event.ding.id
                  }
                }

                if (isDing) {
                  console.log(`RING - Valid Button Press Detected. Ding ID: ${dingId}`)
                  this.emit('buttonPressed', { camera: this.camera, dingId })
                }
              })
            }

            if (this.camera.onMotionDetected) {
              this.camera.onMotionDetected.subscribe((motion) => {
                console.log(`RING - Motion detected: ${motion}`)
              })
            }
          }
        }
        resolve()
      }).catch(err => {
        reject(err)
      })
    })
  }

  // 2) Initiate a live call
  initiateCall() {
    if (this.initiatingCall) return
    this.initiatingCall = true
    this.intentionalDisconnect = false

    return new Promise((resolve, reject) => {
      this._establishCall(resolve, reject)
    })
  }

  async _establishCall(resolve = null, reject = null) {
    if (!this.ringApi) {
      const err = new Error('Ring not initialized. Call initialize() first!')
      if (reject) return reject(err)
      throw err
    }

    try {
      console.log(`RING - Starting live call on camera: ${this.camera.name}`)
      const call = await this.camera.startLiveCall()
      this.currentCall = call

      // If we have a SIP client waiting, request a keyframe immediately
      if (this.sip) {
        console.log('RING - Call (re)started. Requesting Key Frame...')
        setTimeout(() => { if (this.currentCall) this.currentCall.requestKeyFrame() }, 500)
      }

      // Listen for call ended
      call.onCallEnded.subscribe(() => {
        console.log('RING - Call ended')
        if (!this.intentionalDisconnect) {
          console.log('RING - Call dropped unintentionally (Timeout?). Reconnecting in 2s...')
          this.currentCall = null
          this.initiatingCall = false // Allow new call

          setTimeout(() => {
            // We don't pass resolve/reject here as initial promise is long gone
            const result = this.initiateCall()
            if (result && result.catch) {
              result.catch(e => {
                console.error('RING - Reconnection failed', e)
                this.emit('callEnded')
              })
            }
          }, 2000)
        } else {
          console.log('RING - Call ended intentionally.')
          this.emit('callEnded')
        }
      })

      // Listen for call answered
      call.connection.onCallAnswered.subscribe((sdp) => {
        console.log('RING - Call answered, SDP received')
        this.emit('callEstablished')
      })

      // Start playing ringback for demonstration
      call.activateCameraSpeaker()

      // Listen for audio RTP
      call.connection.onAudioRtp.subscribe((rtpPacket) => {
        if (!this.receivingAudio) {
          this.receivingAudio = true
          this.emit('receivingAudio')
        }
        if (this.sip) {
          this.sip.sendAudioPacket(rtpPacket, false)
        }
      })

      // Listen for video RTP
      let videoPacketsReceived = 0
      call.connection.onVideoRtp.subscribe((rtpPacket) => {
        videoPacketsReceived++
        if (videoPacketsReceived % 100 === 0) console.log(`RING - Video packets received: ${videoPacketsReceived}`)
        if (this.sip) {
          this.sip.sendVideoPacket(rtpPacket)
        }
      })

      // Request Key Frame immediately
      setTimeout(() => call.requestKeyFrame(), 1000)
      setInterval(() => call.requestKeyFrame(), 4000) // Periodic keyframe every 4s to help video startup

      // We’ve initiated the call
      if (resolve) resolve()

    } catch (err) {
      console.error('RING - Error initiating call:', err)
      if (reject) reject(err)
      else {
        // If this was a reconnect attempt that failed, we should probably give up
        this.emit('callEnded')
      }
    }
  }

  listen() {
    if (!this.camera) return

    console.log('RING - Subscribing to doorbell presses...')
    this.camera.onDoorbellPressed.subscribe((d) => {
      console.log(`RING - onDoorbellPressed fired`)
      this.emit('buttonPressed', this.camera)
    });
  }




  parseAudioPayloadType(sdp) {
    if (!sdp) return
    // Simple parse to find the first OPUS payload type or default to dynamic
    const lines = sdp.split('\r\n')
    let pt = null

    lines.forEach(line => {
      if (line.startsWith('a=rtpmap:')) {
        // a=rtpmap:111 opus/48000/2
        const match = line.match(/a=rtpmap:(\d+)\s+([\w\-\.]+)/i)
        if (match && match[2].toUpperCase().includes('OPUS')) {
          pt = parseInt(match[1])
        }
      }
    })

    if (pt) {
      console.log(`RING - Detected Audio Payload Type for Ring: ${pt}`)
      this.audioPayloadType = pt
    }
  }



  sendAudioPacket(rtp, isTone = false) {
    // If we haven't configured a destination, do nothing
    if (!this.currentCall) return

    // Use the utility to decide if we drop or forward
    const shouldForward = this.rtpSequencer.process(rtp, isTone)
    if (!shouldForward) return

    if (this.audioPayloadType) {
      rtp.header.payloadType = this.audioPayloadType
    }

    this.currentCall.sendAudioPacket(rtp)
  }

  pipeAudio(sip) {
    this.sip = sip
    // Request a keyframe immediately if we are already connected
    if (this.currentCall && this.currentCall.connection) {
      console.log('RING - SIP attached. Requesting Key Frame for video...')
      this.currentCall.requestKeyFrame()
    }
  }

  // 4) End the Ring call
  cleanup() {
    this.intentionalDisconnect = true
    if (this.currentCall) {
      console.log('RING - Stopping the live call...')
      this.currentCall.stop()
      this.currentCall = null
    }
  }
}

// Export a singleton instance
export const ring = new Ring()

