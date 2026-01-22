class EQVisualizer {
    constructor(canvasId) {
        this.canvasId = canvasId;
        this.canvas = null;
        this.ctx = null;
        this.sampleRate = 96000; // Default, will be updated
        
        // Configuration
        this.minFreq = 20;
        this.maxFreq = 20000;
        this.bars = 64; // Number of frequency bands from 20Hz to 20kHz
        this.useLogScale = true;
        this.smoothing = false;
        this.smoothingBuffer = [];

        // Colors pulled from CSS variables (matches LUFS meter colors)
        const styles = getComputedStyle(document.documentElement);
        this.colors = {
            green: styles.getPropertyValue('--meter-green')?.trim() || '#22c55e',
            yellow: styles.getPropertyValue('--meter-yellow')?.trim() || '#eab308',
            red: styles.getPropertyValue('--meter-red')?.trim() || '#ef4444',
            bg: styles.getPropertyValue('--eq-bg')?.trim() || '#1a1a1a'
        };
        
        // Try to initialize
        this.init();
    }
    
    init() {
        this.canvas = document.getElementById(this.canvasId);
        if (!this.canvas) {
            console.warn(`EQ Visualizer: Canvas element with id "${this.canvasId}" not found`);
            return false;
        }
        this.ctx = this.canvas.getContext('2d');
        
        // Set canvas resolution to match CSS dimensions with device pixel ratio
        if (!this.ensureCanvasSize()) {
            console.warn('EQ Visualizer: Canvas dimensions not ready, will retry on first draw');
            return false;
        }

        console.log(`EQ Visualizer initialized: ${this.canvas.width}x${this.canvas.height}`);
        return true;
    }

    ensureCanvasSize() {
        if (!this.canvas || !this.ctx) return false;

        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;

        const dpr = window.devicePixelRatio || 1;
        const displayWidth = Math.round(rect.width);
        const displayHeight = Math.round(rect.height);
        const renderWidth = Math.round(rect.width * dpr);
        const renderHeight = Math.round(rect.height * dpr);

        const needsResize = this.canvas.width !== renderWidth || this.canvas.height !== renderHeight;

        if (needsResize) {
            // Update CSS size explicitly to keep layout stable
            this.canvas.style.width = `${displayWidth}px`;
            this.canvas.style.height = `${displayHeight}px`;

            // Set actual render size and reset transform for crisp drawing
            this.canvas.width = renderWidth;
            this.canvas.height = renderHeight;
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        return true;
    }
    
    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
        console.log(`EQ Visualizer sample rate set to: ${sampleRate}`);
    }

    setScale(mode) {
        this.useLogScale = mode === 'log';
    }

    setBars(count) {
        this.bars = Math.max(16, Math.min(256, parseInt(count) || 64));
        this.smoothingBuffer = [];
    }

    setSmoothing(enabled) {
        this.smoothing = enabled;
        if (!enabled) this.smoothingBuffer = [];
    }

    draw(frequencyData) {
        // Reinitialize if needed
        if (!this.canvas || !this.ctx) {
            if (!this.init()) return;
        }
        
        // Ensure canvas is correctly sized for device pixel ratio
        if (!this.ensureCanvasSize()) return;
        
        const width = this.canvas.getBoundingClientRect().width;
        const height = this.canvas.getBoundingClientRect().height;
        
        const barWidth = width / this.bars;
        const binCount = frequencyData.length;
        
        // Clear canvas
        this.ctx.fillStyle = this.colors.bg;
        this.ctx.fillRect(0, 0, width, height);
        
        // Draw vertical grid lines at labeled frequencies
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        this.ctx.lineWidth = 1;
        const labelFreqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
        labelFreqs.forEach(freq => {
            const freqRatio = this.useLogScale
                ? (Math.log10(freq) - Math.log10(this.minFreq)) / (Math.log10(this.maxFreq) - Math.log10(this.minFreq))
                : (freq - this.minFreq) / (this.maxFreq - this.minFreq);
            const x = freqRatio * width;
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height - 15);
            this.ctx.stroke();
        });
        
        // Create gradient for bars
        const gradient = this.ctx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, this.colors.green);
        gradient.addColorStop(0.75, this.colors.green);
        gradient.addColorStop(0.75, this.colors.yellow);
        gradient.addColorStop(0.9, this.colors.yellow);
        gradient.addColorStop(0.9, this.colors.red);
        gradient.addColorStop(1, this.colors.red);
        
        // Draw frequency bars
        for (let i = 0; i < this.bars; i++) {
            // Map bar index to frequency range (log or linear)
            const freqRatio = i / (this.bars - 1);
            const freq = this.useLogScale
                ? Math.pow(10, Math.log10(this.minFreq) + freqRatio * (Math.log10(this.maxFreq) - Math.log10(this.minFreq)))
                : this.minFreq + freqRatio * (this.maxFreq - this.minFreq);
            
            // Map frequency to FFT bin
            const nyquist = this.sampleRate / 2;
            const binIndex = Math.floor((freq / nyquist) * binCount);
            
            // Get magnitude for this frequency
            let magnitude = binIndex < binCount ? frequencyData[binIndex] : 0;
            
            // Apply smoothing if enabled
            if (this.smoothing) {
                if (!this.smoothingBuffer[i]) this.smoothingBuffer[i] = magnitude;
                this.smoothingBuffer[i] = this.smoothingBuffer[i] * 0.7 + magnitude * 0.3;
                magnitude = this.smoothingBuffer[i];
            }
            
            const normalizedHeight = (magnitude / 255) * height;
            
            // Draw bar
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(
                i * barWidth + 1,
                height - normalizedHeight,
                barWidth - 2,
                normalizedHeight
            );
        }
        
        // Draw frequency labels
        this.ctx.fillStyle = '#888';
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'center';
        
        labelFreqs.forEach(freq => {
            const freqRatio = this.useLogScale
                ? (Math.log10(freq) - Math.log10(this.minFreq)) / (Math.log10(this.maxFreq) - Math.log10(this.minFreq))
                : (freq - this.minFreq) / (this.maxFreq - this.minFreq);
            const x = freqRatio * width;
            
            let label = freq >= 1000 ? `${freq/1000}k` : `${freq}`;
            this.ctx.fillText(label, x, height - 3);
        });
    }
    
    clear() {
        if (!this.canvas || !this.ctx) return;
        if (!this.ensureCanvasSize()) return;
        const width = this.canvas.getBoundingClientRect().width;
        const height = this.canvas.getBoundingClientRect().height;
        this.ctx.fillStyle = this.colors.bg;
        this.ctx.fillRect(0, 0, width, height);
    }
}

// Export the EQVisualizer class
export default EQVisualizer;