import 'dotenv/config'
import { sip } from './sip.js'
import { ring } from './ring.js'
import { tones } from './tones.js'

const { NOTIFY_URL } = process.env;

// Initialize
Promise.all([
  sip.initialize(),
  ring.initialize()
]).then(() => {
  tones.initialize(sip, ring)
  console.log('INDEX - Initialized.')

  // Setup event listeners for SIP
  sip.on('ringing', () => {
    console.error('INDEX - SIP ringing')
    // for Ring button initiated all, the ring speaker should not play the ringback tone unless sip is actually ringing
    tones.sipRinging()
  })

  sip.on('callEstablished', (rtpInfo) => {
    console.log('INDEX - SIP call established')
    tones.sipReady()
    ring.pipeAudio(sip)
  })

  sip.on('callFailed', (err) => {
    console.error('INDEX - SIP call failed:', err)
    fullCleanup()
  })

  sip.on('callEnded', () => {
    console.log('INDEX - SIP call ended. Cleaning up everything.')
    fullCleanup()
  })

  sip.on('inboundCall', () => {
    console.log('INDEX - Inbound SIP call. Initiating RING call.')
    ring.initiateCall()
  })

  // Setup event listeners for Ring
  ring.on('callEstablished', () => {
    console.log('INDEX - Ring call established')
    sip.pipeAudio(ring)
  })

  ring.on('receivingAudio', () => {
    console.log('INDEX - Receiving audio from Ring')
    tones.ringReady()
  })

  ring.on('callEnded', () => {
    console.log('INDEX - Ring call ended. Cleaning up everything.')
    fullCleanup()
  })

  let lastButtonPress = 0
  let lastDingId = null

  ring.on('buttonPressed', (data) => {
    // Determine if data is the camera object (old way) or { camera, dingId } (new way)
    let camera = data
    let dingId = null

    if (data && data.dingId) {
      camera = data.camera
      dingId = data.dingId
    }

    const now = Date.now()

    // Check Ding ID first (if available)
    if (dingId && lastDingId === dingId) {
      console.log(`INDEX - Button press ignored (Duplicate Ding ID: ${dingId})`)
      return
    }

    // Fallback time debounce (only if IDs are missing or different but very fast?)
    // Actually, if IDs are different, we should allow it!
    // But let's keep a small safety debounce of 500ms even for different IDs to avoid double-triggers
    if (now - lastButtonPress < 500) {
      console.log('INDEX - Button press ignored (debounce time)')
      return
    }

    lastButtonPress = now
    if (dingId) lastDingId = dingId

    console.log(`INDEX - Button pressed for ${camera.name} (ID: ${dingId})`)

    // If a call is already in progress or starting, hang up
    if (ring.initiatingCall || ring.currentCall || sip.initiatingCall || sip.inviteRequest || sip.sipSession) {
      console.log('INDEX - Call active. Playing hangup tone...')

      const tonePromise = tones.playHangup()
      const timeoutPromise = new Promise(resolve => setTimeout(resolve, 2000))

      Promise.race([tonePromise, timeoutPromise]).then(() => {
        console.log('INDEX - Hangup tone done (or timeout). Cleaning up...')
        fullCleanup()
      })
      return
    }

    notify()
    doConnect()
  })

  sip.register()
  ring.listen()
  //doConnect() // for testing purposes
})

process.on('SIGINT', () => {
  console.log('\nINDEX - Caught Ctrl+C. Cleaning up and exiting...')
  fullCleanup()
})

// Functions
function fullCleanup() {
  sip.cleanup()
  ring.cleanup()
  tones.cleanup();
  setTimeout(() => {
    // give sip some time to cleanup
    process.exit(0)
  }, 200);
}

function doConnect(camera) {
  Promise.all([
    sip.initiateCall(),
    ring.initiateCall()
  ])
    .then(() => {
      console.log('INDEX - Both calls initiated in parallel.')
    })
    .catch((err) => {
      console.error('INDEX - Error initiating calls:', err)
      fullCleanup()
    })
}

function notify() {
  if (NOTIFY_URL && NOTIFY_URL.startsWith('http')) {
    fetch(NOTIFY_URL)
      .then(response => response.text())
      .then(data => console.log('INDEX - Notification sent successfully:', data))
      .catch(error => console.error('INDEX - Error sending notification:', error));
  } else {
    console.log('INDEX - NOTIFY_URL is not set or invalid.');
  }
}
