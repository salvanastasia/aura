import { useState, useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { Slider } from '@/components/ui/slider'
import { Upload, Camera, CameraOff, Sparkles, RefreshCw } from 'lucide-react'

/* ─── Camera config ─────────────────────────────────────────────────────── */
const CAM_Z = 5
const FOV = 55

function getVisSize(W, H) {
  const visH = 2 * Math.tan((FOV / 2) * (Math.PI / 180)) * CAM_Z
  return { visW: visH * (W / H), visH }
}

/* ─── Idle cloud (PointsMaterial, depth-aware) ──────────────────────────── */
function buildCloud(scene, visW, visH) {
  const N = 2000
  const pos = new Float32Array(N * 3)
  const col = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * visW * 0.95
    pos[i * 3 + 1] = (Math.random() - 0.5) * visH * 0.95
    pos[i * 3 + 2] = (Math.random() - 0.5) * 1.5
    const g = 0.06 + Math.random() * 0.12
    col[i * 3] = g * 0.3
    col[i * 3 + 1] = g * 0.3
    col[i * 3 + 2] = g * 1.6
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.012,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.65,
  })
  const pts = new THREE.Points(geo, mat)
  scene.add(pts)
  return pts
}

/* ─── Component ──────────────────────────────────────────────────────────── */
export default function ParticleField() {
  const mountRef = useRef(null)
  const videoRef = useRef(null)

  /* Three.js — imageGroup wraps imagePts so rotation/scale apply cleanly */
  const threeRef = useRef({
    renderer: null,
    scene: null,
    camera: null,
    imageGroup: null,
    imagePts: null,
    cloudPts: null,
    raf: null,
  })

  /* Physics buffers */
  const physRef = useRef({
    home: null, // Float32Array — xy home positions (z is always 0 in local space)
    rawZ: null, // Float32Array — unit random z per particle [-0.5, 0.5]
    vel: null, // Float32Array — xyz velocity
    count: 0,
    visW: 0,
    visH: 0,
  })

  /* MediaPipe results: array of per-hand landmark arrays (NOT flattened) */
  const handsRef = useRef([])
  /* Pinch gesture state */
  const gestureRef = useRef({ prevAngle: null, prevDist: null })

  /* Camera refs */
  const camActiveRef = useRef(false)
  const camRafRef = useRef(null)
  const streamRef = useRef(null)

  /* UI state */
  const [mpReady, setMpReady] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [drag, setDrag] = useState(false)
  const [pCount, setPCount] = useState(0)
  const [camError, setCamError] = useState(null)
  const [pinchActive, setPinchActive] = useState(false)

  /* Params */
  const [pSize, setPSize] = useState(0.018)
  const [depthSpread, setDepthSpread] = useState(0.5)
  const [rRadius, setRRadius] = useState(0.65)
  const [rStrength, setRStrength] = useState(0.055)
  const [retSpeed, setRetSpeed] = useState(0.055)
  const [turbulence, setTurbulence] = useState(0.003)
  const [damping, setDamping] = useState(0.88)

  /* Live params ref — read inside RAF without stale closures */
  const pr = useRef({})
  useEffect(() => {
    pr.current = { pSize, depthSpread, rRadius, rStrength, retSpeed, turbulence, damping }
  })

  /* Debounced setPinchActive from RAF */
  const pinchTimerRef = useRef(null)
  const signalPinch = useCallback((active) => {
    clearTimeout(pinchTimerRef.current)
    if (active) {
      setPinchActive(true)
    } else {
      pinchTimerRef.current = setTimeout(() => setPinchActive(false), 200)
    }
  }, [])

  /* ── Init Three.js ───────────────────────────────────────────────────── */
  useEffect(() => {
    const el = mountRef.current
    const W = el.clientWidth || 800
    const H = el.clientHeight || 600
    const { visW, visH } = getVisSize(W, H)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setSize(W, H)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 1)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(FOV, W / H, 0.1, 1000)
    camera.position.z = CAM_Z

    const imageGroup = new THREE.Group()
    scene.add(imageGroup)

    const cloudPts = buildCloud(scene, visW, visH)

    threeRef.current = { renderer, scene, camera, imageGroup, imagePts: null, cloudPts, raf: null }
    physRef.current.visW = visW
    physRef.current.visH = visH

    let t = 0
    const idle = () => {
      threeRef.current.raf = requestAnimationFrame(idle)
      t += 0.001
      const pos = cloudPts.geometry.attributes.position.array
      for (let i = 0; i < pos.length / 3; i++) {
        pos[i * 3 + 1] += Math.sin(t + i * 0.31) * 0.002
        pos[i * 3] += Math.cos(t + i * 0.19) * 0.0015
      }
      cloudPts.geometry.attributes.position.needsUpdate = true
      renderer.render(scene, camera)
    }
    idle()

    return () => {
      cancelAnimationFrame(threeRef.current.raf)
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [])

  /* ── Load MediaPipe Hands ────────────────────────────────────────────── */
  useEffect(() => {
    const src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js'
    if (document.querySelector(`script[src="${src}"]`)) {
      setMpReady(true)
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.onload = () => setMpReady(true)
    s.onerror = () => console.error('MediaPipe Hands failed')
    document.head.appendChild(s)
  }, [])

  /* ── Main physics + gesture render loop ─────────────────────────────── */
  const startAnim = useCallback(() => {
    cancelAnimationFrame(threeRef.current.raf)
    const { renderer, scene, camera } = threeRef.current

    const loop = () => {
      threeRef.current.raf = requestAnimationFrame(loop)

      const pts = threeRef.current.imagePts
      const imageGroup = threeRef.current.imageGroup
      const { home, rawZ, vel, count, visW, visH } = physRef.current
      const {
        pSize: sz,
        depthSpread: dpt,
        rRadius: rr,
        rStrength: rs,
        retSpeed: ret,
        turbulence: tb,
        damping: dp,
      } = pr.current
      const hands = handsRef.current // array of per-hand landmark arrays

      /* ── Pinch gesture detection ─────────────────────────────────── */
      const getPinch = (lms) => {
        if (!lms || lms.length < 21) return null
        const th = lms[4] // thumb tip
        const ix = lms[8] // index tip
        const d = Math.hypot(th.x - ix.x, th.y - ix.y)
        return {
          isPinching: d < 0.09,
          midX: (th.x + ix.x) / 2,
          midY: (th.y + ix.y) / 2,
          pinchDist: d,
        }
      }

      if (imageGroup && hands.length >= 2) {
        const p1 = getPinch(hands[0])
        const p2 = getPinch(hands[1])
        const g = gestureRef.current

        if (p1?.isPinching && p2?.isPinching) {
          signalPinch(true)

          /* Angle of the line connecting the two pinch midpoints */
          const angle = Math.atan2(p2.midY - p1.midY, p2.midX - p1.midX)
          /* Distance between the two pinch midpoints */
          const dist = Math.hypot(p2.midX - p1.midX, p2.midY - p1.midY)

          if (g.prevAngle !== null && g.prevDist > 0.001) {
            /* Rotation: delta angle of the midpoint line */
            let da = angle - g.prevAngle
            if (da > Math.PI) da -= 2 * Math.PI
            if (da < -Math.PI) da += 2 * Math.PI
            imageGroup.rotation.z -= da

            /* Zoom: ratio of midpoint distances */
            const scaleFactor = dist / g.prevDist
            const nextScale = imageGroup.scale.x * scaleFactor
            imageGroup.scale.setScalar(Math.max(0.1, Math.min(8, nextScale)))
          }

          g.prevAngle = angle
          g.prevDist = dist
        } else {
          signalPinch(false)
          g.prevAngle = null
          g.prevDist = null
        }
      } else {
        signalPinch(false)
        gestureRef.current.prevAngle = null
        gestureRef.current.prevDist = null
      }

      /* ── Particle physics ────────────────────────────────────────── */
      if (pts && home && rawZ && vel && count > 0) {
        const pos = pts.geometry.attributes.position.array
        if (pts.material.size !== sz) pts.material.size = sz

        for (let i = 0; i < count; i++) {
          const i3 = i * 3
          const px = pos[i3]
          const py = pos[i3 + 1]
          const pz = pos[i3 + 2]

          /* Spring toward home (xy) and depth home (z) */
          vel[i3] += (home[i3] - px) * ret
          vel[i3 + 1] += (home[i3 + 1] - py) * ret
          vel[i3 + 2] += (rawZ[i] * dpt - pz) * ret * 0.35

          /* Repulsion from every landmark on every hand */
          for (const hand of hands) {
            for (const lm of hand) {
              /* Map MediaPipe [0,1] → world space at z=0 plane */
              const wx = (1 - lm.x) * visW - visW / 2 // mirror x (webcam front-facing)
              const wy = (0.5 - lm.y) * visH // flip y
              const dx = px - wx
              const dy = py - wy
              const d = Math.sqrt(dx * dx + dy * dy)
              if (d < rr && d > 0.001) {
                const f = (1 - d / rr) * rs
                vel[i3] += (dx / d) * f
                vel[i3 + 1] += (dy / d) * f
              }
            }
          }

          /* Turbulence + damping */
          vel[i3] = (vel[i3] + (Math.random() - 0.5) * tb) * dp
          vel[i3 + 1] = (vel[i3 + 1] + (Math.random() - 0.5) * tb) * dp
          vel[i3 + 2] = (vel[i3 + 2] + (Math.random() - 0.5) * tb * 0.25) * dp

          pos[i3] += vel[i3]
          pos[i3 + 1] += vel[i3 + 1]
          pos[i3 + 2] += vel[i3 + 2]
        }

        pts.geometry.attributes.position.needsUpdate = true
      }

      renderer.render(scene, camera)
    }
    loop()
  }, [signalPinch])

  /* ── Reset particles + transform ────────────────────────────────────── */
  const resetParticles = useCallback(() => {
    const { home, rawZ, vel, count } = physRef.current
    const pts = threeRef.current.imagePts
    const imageGroup = threeRef.current.imageGroup
    if (!pts || !home || !vel) return
    const pos = pts.geometry.attributes.position.array
    const dpt = pr.current.depthSpread
    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      pos[i3] = home[i3]
      pos[i3 + 1] = home[i3 + 1]
      pos[i3 + 2] = rawZ[i] * dpt
      vel[i3] = 0
      vel[i3 + 1] = 0
      vel[i3 + 2] = 0
    }
    pts.geometry.attributes.position.needsUpdate = true
    if (imageGroup) {
      imageGroup.rotation.set(0, 0, 0)
      imageGroup.scale.setScalar(1)
    }
  }, [])

  /* ── Load image via FileReader → particles ───────────────────────────── */
  const loadImg = useCallback(
    (file) => {
      if (!file || !file.type.startsWith('image/')) return

      const reader = new FileReader()
      reader.onload = (ev) => {
        const img = new Image()
        img.onload = () => {
          const { scene, imageGroup, cloudPts } = threeRef.current
          const { visW, visH } = physRef.current

          /* Downsample — longest side ≤ 150px */
          const MAX = 150
          const sc = Math.min(MAX / img.width, MAX / img.height, 1)
          const sw = Math.max(1, Math.round(img.width * sc))
          const sh = Math.max(1, Math.round(img.height * sc))

          const oc = document.createElement('canvas')
          oc.width = sw
          oc.height = sh
          const ctx = oc.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(img, 0, 0, sw, sh)

          let px
          try {
            px = ctx.getImageData(0, 0, sw, sh).data
          } catch (e) {
            console.error('getImageData:', e)
            return
          }

          /* Fit image into 80% of visible canvas */
          const ds = Math.min((visW * 0.8) / sw, (visH * 0.8) / sh)
          const ox = -(sw * ds) / 2
          const oy = (sh * ds) / 2
          const dpt = pr.current.depthSpread

          const posArr = []
          const colArr = []
          const rawZArr = []

          for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
              const pi = (y * sw + x) * 4
              if (px[pi + 3] < 20) continue // skip transparent
              const rz = Math.random() - 0.5 // unit random z [-0.5, 0.5]
              posArr.push(ox + x * ds, oy - y * ds, rz * dpt)
              colArr.push(px[pi] / 255, px[pi + 1] / 255, px[pi + 2] / 255)
              rawZArr.push(rz)
            }
          }

          if (posArr.length === 0) {
            console.warn('No visible pixels')
            return
          }

          const count = posArr.length / 3

          /* home stores only xy; z is computed live from rawZ * depthSpread */
          const homeArr = new Float32Array(posArr)
          for (let i = 0; i < count; i++) homeArr[i * 3 + 2] = 0

          physRef.current.home = homeArr
          physRef.current.rawZ = new Float32Array(rawZArr)
          physRef.current.vel = new Float32Array(count * 3).fill(0)
          physRef.current.count = count

          const geo = new THREE.BufferGeometry()
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3))
          geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colArr), 3))

          const mat = new THREE.PointsMaterial({
            size: pr.current.pSize,
            vertexColors: true,
            sizeAttenuation: true, // particles at greater z appear smaller → depth illusion
          })

          /* Remove previous image points */
          if (threeRef.current.imagePts) {
            imageGroup.remove(threeRef.current.imagePts)
            threeRef.current.imagePts.geometry.dispose()
            threeRef.current.imagePts.material.dispose()
          }
          if (cloudPts) cloudPts.visible = false

          /* Reset group transform */
          imageGroup.rotation.set(0, 0, 0)
          imageGroup.scale.setScalar(1)

          const pts = new THREE.Points(geo, mat)
          imageGroup.add(pts)
          threeRef.current.imagePts = pts

          setPCount(count)
          setImgLoaded(true)
          startAnim()
        }
        img.onerror = (e) => console.error('Image error:', e)
        img.src = ev.target.result // data: URL — zero CORS issues
      }
      reader.onerror = (e) => console.error('FileReader error:', e)
      reader.readAsDataURL(file)
    },
    [startAnim],
  )

  /* ── Camera / hand tracking ──────────────────────────────────────────── */
  const toggleCam = useCallback(
    async () => {
      if (camOn) {
        camActiveRef.current = false
        cancelAnimationFrame(camRafRef.current)
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
        handsRef.current = []
        setCamOn(false)
        setCamError(null)
        return
      }
      if (!mpReady) return
      setCamError(null)

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        })
        streamRef.current = stream

        const vid = videoRef.current
        vid.srcObject = stream
        vid.playsInline = true
        vid.muted = true
        await vid.play()

        const H = new window.Hands({
          locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
        })
        H.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.65,
          minTrackingConfidence: 0.5,
        })
        H.onResults((r) => {
          /* Keep per-hand arrays — NOT flattened — so pinch detection works per hand */
          handsRef.current = r.multiHandLandmarks ?? []
        })
        await H.initialize()

        camActiveRef.current = true
        const sendFrame = async () => {
          if (!camActiveRef.current) return
          if (vid.readyState >= 2) {
            try {
              await H.send({ image: vid })
            } catch (_) {}
          }
          camRafRef.current = requestAnimationFrame(sendFrame)
        }
        sendFrame()

        setCamOn(true)
      } catch (err) {
        console.error('Camera error:', err)
        const msg =
          err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access in browser settings.'
            : err.name === 'NotFoundError'
              ? 'No camera found on this device.'
              : err.name === 'NotReadableError'
                ? 'Camera is in use by another app.'
                : `Camera error: ${err.message}`
        setCamError(msg)
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    },
    [camOn, mpReady],
  )

  /* Cleanup on unmount */
  useEffect(
    () => () => {
      camActiveRef.current = false
      cancelAnimationFrame(camRafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      clearTimeout(pinchTimerRef.current)
    },
    [],
  )

  /* ── File handlers ───────────────────────────────────────────────────── */
  const onDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDrag(false)
      loadImg(e.dataTransfer?.files?.[0])
    },
    [loadImg],
  )
  const onFile = useCallback(
    (e) => {
      loadImg(e.target.files?.[0])
      e.target.value = ''
    },
    [loadImg],
  )

  /* ── Slider config ───────────────────────────────────────────────────── */
  const sliders = [
    { label: 'Particle Size', val: pSize, set: setPSize, min: 0.005, max: 0.05, step: 0.001 },
    { label: 'Depth Spread', val: depthSpread, set: setDepthSpread, min: 0, max: 3, step: 0.05 },
    { label: 'Repulsion Radius', val: rRadius, set: setRRadius, min: 0.1, max: 2.0, step: 0.05 },
    { label: 'Repulsion Force', val: rStrength, set: setRStrength, min: 0, max: 0.3, step: 0.005 },
    { label: 'Return Speed', val: retSpeed, set: setRetSpeed, min: 0.01, max: 0.18, step: 0.005 },
    { label: 'Turbulence', val: turbulence, set: setTurbulence, min: 0, max: 0.02, step: 0.0005 },
    { label: 'Damping', val: damping, set: setDamping, min: 0.7, max: 0.99, step: 0.01 },
  ]

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&display=swap');
        *, *::before, *::after {
          font-family: 'Geist Mono', 'Courier New', monospace !important;
          box-sizing: border-box; margin: 0; padding: 0;
        }
        :root {
          --bg:         #000000;
          --sidebar:    #080808;
          --border:     #161616;
          --bm:         #222222;
          --tdim:       #303030;
          --tmuted:     #545454;
          --tmid:       #888888;
          --tmain:      #d4d4d4;
          --accent:     #a3e635;
          --accent-d:   rgba(163,230,53,.10);
          --red:        #ef4444;
          --amber:      #f59e0b;
        }
        html, body, #root { height: 100%; }
        .w { display:flex; width:100%; height:100vh; background:var(--bg); color:var(--tmain); overflow:hidden; }

        /* Canvas */
        .cv { flex:1; position:relative; overflow:hidden; }
        .cv canvas { display:block; }

        /* Drop overlay */
        .drop {
          position:absolute; inset:0; display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:14px;
          border:1.5px dashed var(--bm); margin:28px; border-radius:14px;
          transition:border-color .2s,background .2s; pointer-events:all;
        }
        .drop.over { border-color:var(--accent); background:rgba(163,230,53,.04); }
        .di { width:46px;height:46px; border:1px solid var(--bm); border-radius:12px; display:flex;align-items:center;justify-content:center; color:var(--tmuted); }
        .dt { font-size:11px;letter-spacing:.18em;color:var(--tmuted);text-transform:uppercase; }
        .ds { font-size:10px;color:var(--tdim); }
        .dl { font-size:10px;color:var(--tmuted);text-decoration:underline;text-underline-offset:3px;cursor:pointer;transition:color .15s; }
        .dl:hover { color:var(--tmid); }

        /* HUD badges */
        .badge {
          position:absolute; top:18px; left:18px; display:flex;align-items:center;gap:8px;
          font-size:9px;letter-spacing:.14em;text-transform:uppercase;
          color:var(--tmid);background:rgba(0,0,0,.8);
          border:1px solid var(--bm);padding:6px 12px;border-radius:100px;backdrop-filter:blur(8px);
          transition:opacity .3s;
        }
        .badge.pinch { color:var(--amber); border-color:rgba(245,158,11,.3); background:rgba(245,158,11,.07); }
        .dot { width:6px;height:6px;border-radius:50%;background:var(--accent);animation:blink 1.6s ease infinite; }
        .dot.amber { background:var(--amber); }
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}

        .pcount { position:absolute;bottom:18px;left:18px;font-size:9px;letter-spacing:.12em;color:var(--tdim);text-transform:uppercase; }

        /* Gesture hint — bottom of canvas */
        .ghint {
          position:absolute; bottom:18px; right:18px;
          font-size:8px;letter-spacing:.1em;color:var(--tdim);text-transform:uppercase;
          text-align:right;line-height:1.8;
        }

        /* Sidebar */
        .sb { width:264px;min-width:264px;background:var(--sidebar);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto; }
        .sh { padding:22px 20px 18px;border-bottom:1px solid var(--border); }
        .st { font-size:11px;letter-spacing:.22em;color:var(--tmid);text-transform:uppercase;font-weight:500; }
        .ss { font-size:9px;color:var(--tdim);margin-top:4px;letter-spacing:.07em; }

        .sec { padding:14px 18px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:7px; }

        .btn {
          display:flex;align-items:center;gap:8px;
          font-size:9px;letter-spacing:.12em;text-transform:uppercase;
          color:var(--tmid);background:transparent;
          border:1px solid var(--bm);padding:9px 12px;
          border-radius:8px;cursor:pointer;transition:all .15s;width:100%;
        }
        .btn:hover:not(:disabled){border-color:var(--tmuted);color:var(--tmain);background:rgba(255,255,255,.02);}
        .btn:disabled{opacity:.28;cursor:not-allowed;}
        .btn.stop{color:var(--red);border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.06);}
        .btn.go{color:var(--accent);border-color:rgba(163,230,53,.25);background:var(--accent-d);}
        .btn svg{flex-shrink:0;}
        .err{font-size:9px;color:var(--red);letter-spacing:.05em;line-height:1.55;}

        /* Gesture info box */
        .gbox {
          padding:12px 18px; border-bottom:1px solid var(--border);
          display:flex;flex-direction:column;gap:6px;
        }
        .glabel { font-size:8px;letter-spacing:.16em;color:var(--tdim);text-transform:uppercase;margin-bottom:2px; }
        .gline { display:flex;align-items:center;gap:7px;font-size:9px;color:var(--tmuted); }
        .gicon { font-size:11px; }

        /* Params */
        .params{padding:18px 18px 0;flex:1;}
        .plabel{font-size:8px;letter-spacing:.2em;color:var(--tdim);text-transform:uppercase;margin-bottom:18px;}
        .srow{margin-bottom:20px;}
        .smeta{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px;}
        .slabel{font-size:9px;letter-spacing:.1em;color:var(--tmuted);text-transform:uppercase;}
        .sval{font-size:10px;color:var(--tmid);min-width:44px;text-align:right;}

        .foot{padding:14px 18px;border-top:1px solid var(--border);margin-top:auto;}
        .ftip{font-size:8px;color:var(--tdim);line-height:1.7;letter-spacing:.04em;}

        [data-slot="slider-track"]  { background:var(--bm) !important; }
        [data-slot="slider-range"]  { background:var(--tmuted) !important; }
        [data-slot="slider-thumb"]  { background:var(--tmain) !important;border:none !important;box-shadow:none !important;width:10px !important;height:10px !important; }
      `}</style>

      <div className="w">
        {/* ── Canvas pane ─────────────────────────────── */}
        <div
          className="cv"
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

          {/* Drop overlay */}
          {!imgLoaded && (
            <div className={`drop ${drag ? 'over' : ''}`}>
              <div className="di">
                <Sparkles size={20} />
              </div>
              <p className="dt">Drop an image here</p>
              <p className="ds">PNG · JPG · WebP · any size</p>
              <label className="dl">
                or browse files
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
              </label>
            </div>
          )}

          {/* Active hand tracking badge */}
          {camOn && !pinchActive && (
            <div className="badge">
              <div className="dot" /> Hand tracking active
            </div>
          )}

          {/* Pinch active badge */}
          {camOn && pinchActive && (
            <div className="badge pinch">
              <div className="dot amber" /> Pinch gesture detected
            </div>
          )}

          {/* Particle count */}
          {imgLoaded && <div className="pcount">{pCount.toLocaleString()} particles</div>}

          {/* Gesture hint */}
          {camOn && imgLoaded && (
            <div className="ghint">
              pinch both hands → rotate
              <br />
              spread pinch apart → zoom
            </div>
          )}

          {/* Video: must be in DOM, playing, but invisible */}
          <video
            ref={videoRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
            }}
            playsInline
            muted
          />
        </div>

        {/* ── Sidebar ─────────────────────────────────── */}
        <aside className="sb">
          <div className="sh">
            <div className="st">Particle Field</div>
            <div className="ss">three.js · webgl · mediapipe hands</div>
          </div>

          {/* Actions */}
          <div className="sec">
            <label className="btn" style={{ cursor: 'pointer' }}>
              <Upload size={11} />
              {imgLoaded ? 'Load New Image' : 'Upload Image'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
            </label>

            {imgLoaded && (
              <button className="btn" onClick={resetParticles}>
                <RefreshCw size={11} /> Reset Particles
              </button>
            )}

            <button className={`btn ${camOn ? 'stop' : 'go'}`} onClick={toggleCam} disabled={!mpReady}>
              {camOn ? <CameraOff size={11} /> : <Camera size={11} />}
              {!mpReady ? 'Loading MediaPipe…' : camOn ? 'Stop Camera' : 'Start Hand Tracking'}
            </button>

            {camError && <p className="err">{camError}</p>}
          </div>

          {/* Gesture guide */}
          <div className="gbox">
            <div className="glabel">Gestures</div>
            <div className="gline">
              <span className="gicon">🤏</span> Open hand — repel particles
            </div>
            <div className="gline">
              <span className="gicon">🤌</span> Both pinch + rotate — spin
            </div>
            <div className="gline">
              <span className="gicon">↔️</span> Both pinch + spread — zoom
            </div>
          </div>

          {/* Sliders */}
          <div className="params">
            <div className="plabel">Parameters</div>
            {sliders.map(({ label, val, set, min, max, step }) => {
              const dec = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0
              return (
                <div key={label} className="srow">
                  <div className="smeta">
                    <span className="slabel">{label}</span>
                    <span className="sval">{val.toFixed(dec)}</span>
                  </div>
                  <Slider min={min} max={max} step={step} value={[val]} onValueChange={([v]) => set(v)} />
                </div>
              )
            })}
          </div>

          <div className="foot">
            <p className="ftip">
              Depth Spread scatters particles along the z-axis giving a 3D parallax feel via the
              perspective camera. Combine with hand tracking for full spatial interaction.
            </p>
          </div>
        </aside>
      </div>
    </>
  )
}

