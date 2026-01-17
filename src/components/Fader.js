/**
 * Fader.js - Vertical/horizontal fader control
 * Simplified version without anime.js
 */

import { controlTheme, calculateDragValue, calculateWheelValue } from './theme.js';

export class Fader {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.container) return;

    this.options = {
      min: options.min ?? -12,
      max: options.max ?? 12,
      value: options.value ?? 0,
      step: options.step ?? 0.1,
      label: options.label ?? '',
      unit: options.unit ?? 'dB',
      orientation: options.orientation ?? 'vertical',
      width: options.width ?? (options.orientation === 'horizontal' ? 150 : 32),
      height: options.height ?? (options.orientation === 'horizontal' ? 32 : 120),
      color: options.color ?? controlTheme.functional.gain,
      showScale: options.showScale ?? false,
      showValue: options.showValue ?? true,
      decimals: options.decimals ?? 1,
      onChange: options.onChange ?? (() => {}),
      onChangeEnd: options.onChangeEnd ?? (() => {}),
    };

    this.value = this.options.value;
    this._isDragging = false;

    const isVertical = this.options.orientation === 'vertical';
    this._thumbCursor = isVertical ? 'ns-resize' : 'ew-resize';

    this.render();
    this.bindEvents();
  }

  render() {
    const { width, height, label, color, orientation, showScale, showValue, unit, min, max } = this.options;
    const isVertical = orientation === 'vertical';
    const trackThickness = 6;
    const thumbSize = isVertical ? { w: 24, h: 10 } : { w: 10, h: 24 };

    // Clear container and build DOM elements programmatically (safer than innerHTML)
    this.container.textContent = '';

    // Wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'fader-wrapper';
    Object.assign(wrapper.style, {
      display: 'flex',
      flexDirection: isVertical ? 'column' : 'row',
      alignItems: 'center',
      gap: '6px',
      userSelect: 'none',
    });

    // Label (top for vertical)
    if (label && isVertical) {
      const labelEl = document.createElement('div');
      labelEl.className = 'fader-label';
      labelEl.textContent = label;
      Object.assign(labelEl.style, {
        fontSize: '10px',
        color: controlTheme.text.muted,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
      });
      wrapper.appendChild(labelEl);
    }

    // Track container
    const trackContainer = document.createElement('div');
    trackContainer.className = 'fader-track-container';
    Object.assign(trackContainer.style, {
      position: 'relative',
      width: `${width}px`,
      height: `${height}px`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });

    // Scale marks for dB faders
    if (showScale && unit === 'dB') {
      const marks = [12, 6, 0, -6, -12, -24, -48, -60].filter(db => db >= min && db <= max);
      marks.forEach(db => {
        const norm = (db - min) / (max - min);
        const pos = isVertical ? (1 - norm) * 100 : norm * 100;
        const mark = document.createElement('div');
        mark.textContent = db > 0 ? '+' + db : String(db);
        Object.assign(mark.style, {
          position: 'absolute',
          fontSize: '9px',
          color: controlTheme.text.muted,
          fontFamily: 'ui-monospace, monospace',
          transform: isVertical ? 'translateY(-50%)' : 'translateX(-50%)',
        });
        if (isVertical) {
          mark.style.top = `${pos}%`;
          mark.style.right = '100%';
          mark.style.marginRight = '6px';
        } else {
          mark.style.left = `${pos}%`;
          mark.style.top = '100%';
          mark.style.marginTop = '6px';
        }
        trackContainer.appendChild(mark);
      });
    }

    // Track background
    const track = document.createElement('div');
    track.className = 'fader-track';
    Object.assign(track.style, {
      position: 'absolute',
      background: 'rgba(255,255,255,0.1)',
      borderRadius: `${trackThickness / 2}px`,
      cursor: 'pointer',
    });
    if (isVertical) {
      Object.assign(track.style, {
        width: `${trackThickness}px`,
        height: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
      });
    } else {
      Object.assign(track.style, {
        height: `${trackThickness}px`,
        width: '100%',
        top: '50%',
        transform: 'translateY(-50%)',
      });
    }

    // Fill
    const fill = document.createElement('div');
    fill.className = 'fader-fill';
    Object.assign(fill.style, {
      position: 'absolute',
      background: color,
      borderRadius: `${trackThickness / 2}px`,
      boxShadow: `0 0 8px ${color}40`,
      transition: `${isVertical ? 'height' : 'width'} 0.05s ease-out`,
    });
    if (isVertical) {
      Object.assign(fill.style, { bottom: '0', left: '0', right: '0' });
    } else {
      Object.assign(fill.style, { left: '0', top: '0', bottom: '0' });
    }
    track.appendChild(fill);
    trackContainer.appendChild(track);

    // Thumb
    const thumb = document.createElement('div');
    thumb.className = 'fader-thumb';
    Object.assign(thumb.style, {
      position: 'absolute',
      width: `${thumbSize.w}px`,
      height: `${thumbSize.h}px`,
      background: `linear-gradient(${isVertical ? '180deg' : '90deg'}, #666, #444)`,
      borderRadius: '2px',
      cursor: this._thumbCursor,
      boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
      transition: 'bottom 0.05s ease-out, left 0.05s ease-out, box-shadow 0.1s',
    });
    if (isVertical) {
      thumb.style.left = '50%';
      thumb.style.transform = 'translate(-50%, 50%)';
    } else {
      thumb.style.top = '50%';
      thumb.style.transform = 'translate(-50%, -50%)';
    }

    // Grip lines
    const grip = document.createElement('div');
    Object.assign(grip.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      background: '#222',
      transform: 'translate(-50%, -50%)',
    });
    if (isVertical) {
      Object.assign(grip.style, {
        width: '12px',
        height: '1px',
        boxShadow: '0 2px 0 #222, 0 -2px 0 #222',
      });
    } else {
      Object.assign(grip.style, {
        width: '1px',
        height: '12px',
        boxShadow: '2px 0 0 #222, -2px 0 0 #222',
      });
    }
    thumb.appendChild(grip);
    trackContainer.appendChild(thumb);
    wrapper.appendChild(trackContainer);

    // Value display
    let valueDisplay = null;
    if (showValue) {
      valueDisplay = document.createElement('div');
      valueDisplay.className = 'fader-value';
      Object.assign(valueDisplay.style, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '11px',
        fontWeight: '500',
        color: controlTheme.text.value,
        minWidth: '45px',
        textAlign: 'center',
      });
      wrapper.appendChild(valueDisplay);
    }

    // Label (bottom for horizontal)
    if (label && !isVertical) {
      const labelEl = document.createElement('div');
      labelEl.className = 'fader-label';
      labelEl.textContent = label;
      Object.assign(labelEl.style, {
        fontSize: '10px',
        color: controlTheme.text.muted,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      });
      wrapper.appendChild(labelEl);
    }

    this.container.appendChild(wrapper);

    this.track = track;
    this.fill = fill;
    this.thumb = thumb;
    this.valueDisplay = valueDisplay;
    this.trackContainer = trackContainer;

    this.updateDisplay();
  }

  bindEvents() {
    const isVertical = this.options.orientation === 'vertical';

    // Thumb drag
    this.thumb.addEventListener('mousedown', (e) => this.onDragStart(e));
    this.thumb.addEventListener('touchstart', (e) => this.onDragStart(e), { passive: false });

    // Track click
    this.track.addEventListener('click', (e) => {
      const rect = this.track.getBoundingClientRect();
      let norm;
      if (isVertical) {
        norm = 1 - (e.clientY - rect.top) / rect.height;
      } else {
        norm = (e.clientX - rect.left) / rect.width;
      }
      const newValue = this.options.min + norm * (this.options.max - this.options.min);
      this.setValue(this.quantize(newValue), true);
    });

    // Wheel
    this.trackContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const newValue = calculateWheelValue(
        this.value,
        e.deltaY,
        this.options.min,
        this.options.max,
        e.shiftKey
      );
      this.setValue(this.quantize(newValue), true);
    }, { passive: false });

    // Double-click reset
    this.thumb.addEventListener('dblclick', () => {
      const resetValue = this.options.unit === 'dB' ? 0 : (this.options.min + this.options.max) / 2;
      this.setValue(resetValue, true);
    });
  }

  onDragStart(e) {
    e.preventDefault();
    e.stopPropagation();
    this._isDragging = true;

    this._savedBodyCursor = document.body.style.cursor;
    document.body.style.cursor = this._thumbCursor;
    document.body.style.userSelect = 'none';

    const isVertical = this.options.orientation === 'vertical';
    const startPos = e.type === 'touchstart'
      ? (isVertical ? e.touches[0].clientY : e.touches[0].clientX)
      : (isVertical ? e.clientY : e.clientX);
    const startValue = this.value;

    // Glow effect
    this.thumb.style.boxShadow = `0 1px 4px rgba(0,0,0,0.5), 0 0 8px ${this.options.color}`;

    const onMove = (e) => {
      if (!this._isDragging) return;
      e.preventDefault();

      const currentPos = e.type === 'touchmove'
        ? (isVertical ? e.touches[0].clientY : e.touches[0].clientX)
        : (isVertical ? e.clientY : e.clientX);

      const delta = isVertical ? startPos - currentPos : currentPos - startPos;

      const newValue = calculateDragValue(
        startValue,
        delta,
        this.options.min,
        this.options.max,
        e.shiftKey
      );

      this.setValue(this.quantize(newValue), true);
    };

    const onEnd = () => {
      this._isDragging = false;
      document.body.style.cursor = this._savedBodyCursor || '';
      document.body.style.userSelect = '';
      this.thumb.style.boxShadow = '0 1px 4px rgba(0,0,0,0.5)';

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);

      this.options.onChangeEnd(this.value);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  quantize(value) {
    const { step, min, max } = this.options;
    const quantized = Math.round(value / step) * step;
    return Math.max(min, Math.min(max, quantized));
  }

  setValue(val, triggerCallback = false) {
    const oldValue = this.value;
    this.value = this.quantize(val);
    this.updateDisplay();

    if (triggerCallback && oldValue !== this.value) {
      this.options.onChange(this.value);
    }
  }

  updateDisplay() {
    const { min, max, orientation, decimals, unit } = this.options;
    const isVertical = orientation === 'vertical';
    const norm = (this.value - min) / (max - min);

    // Update fill
    if (isVertical) {
      this.fill.style.height = `${norm * 100}%`;
    } else {
      this.fill.style.width = `${norm * 100}%`;
    }

    // Update thumb position
    if (isVertical) {
      this.thumb.style.bottom = `${norm * 100}%`;
    } else {
      this.thumb.style.left = `${norm * 100}%`;
    }

    // Update value display
    if (this.valueDisplay) {
      const sign = this.value > 0 && unit === 'dB' ? '+' : '';
      this.valueDisplay.textContent = `${sign}${this.value.toFixed(decimals)}${unit ? ' ' + unit : ''}`;
    }
  }

  getValue() {
    return this.value;
  }

  get isDragging() {
    return this._isDragging;
  }

  setEnabled(enabled) {
    this.trackContainer.style.opacity = enabled ? 1 : 0.4;
    this.trackContainer.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  destroy() {
    // Clean up any active drag state
    if (this._isDragging) {
      this._isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    this.container.textContent = '';
  }
}

export default Fader;
