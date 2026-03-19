import { useState, useEffect } from 'react'

// Minimal slider component that mimics the shadcn/ui slider API
// used by ParticleField. It exposes data-slot attributes so the
// existing CSS in ParticleField can style it.

export function Slider({ min = 0, max = 100, step = 1, value = [0], onValueChange }) {
  const [current, setCurrent] = useState(value[0] ?? min)

  useEffect(() => {
    if (Array.isArray(value) && typeof value[0] === 'number' && value[0] !== current) {
      setCurrent(value[0])
    }
  }, [value, current])

  const percent = ((current - min) / (max - min || 1)) * 100

  const handleChange = (e) => {
    const next = Number(e.target.value)
    setCurrent(next)
    onValueChange?.([next])
  }

  return (
    <div style={{ width: '100%', position: 'relative', height: 18 }}>
      <div
        data-slot="slider-root"
        style={{
          position: 'relative',
          width: '100%',
          height: 4,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div
          data-slot="slider-track"
          style={{
            position: 'relative',
            width: '100%',
            height: 4,
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            data-slot="slider-range"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${percent}%`,
            }}
          />
        </div>
        <div
          data-slot="slider-thumb"
          style={{
            position: 'absolute',
            left: `${percent}%`,
            transform: 'translate(-50%, 0)',
            width: 10,
            height: 10,
            borderRadius: '50%',
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          onChange={handleChange}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: 'pointer',
          }}
        />
      </div>
    </div>
  )
}

