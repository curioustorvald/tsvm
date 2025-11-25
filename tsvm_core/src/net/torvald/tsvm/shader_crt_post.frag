

// ============================================================================
// CRT + NTSC Composite/S-Video Signal Simulation Shader (Enhanced Version)
// ============================================================================
// Features:
// - Runtime-switchable composite/S-Video mode (no recompilation)
// - Adjustable signal and CRT parameters via uniforms
// - Accurate NTSC color artifact simulation
// - Animated dot crawl effect
// - Trinitron phosphor mask
// - Optional bloom/glow effect
// ============================================================================

// === UNIFORMS ===
uniform float time = 0.0;              // Frame count
uniform vec2 resolution = vec2(640.0, 480.0); // Virtual resolution (e.g., 640x480)
uniform sampler2D u_texture;     // Input texture
uniform vec2 flip = vec2(0.0, 0.0); // UV flip control (0,1 = flip Y)

// Signal mode: 0 = S-Video, 1 = Composite, 2 = CGA Composite
// Can be changed at runtime without recompilation
uniform int signalMode = 1;      // Default should be 1 for composite

// CGA-specific settings
uniform float cgaHue;            // Hue adjustment for CGA (default: 0.0, range: -PI to PI)
uniform float cgaSaturation;     // Saturation multiplier for CGA (default: 1.0)

// Optional adjustable parameters (set reasonable defaults if not provided)
uniform float lumaFilterWidth;   // Default: 1.5
uniform float chromaIFilterWidth; // Default: 3.5
uniform float chromaQFilterWidth; // Default: 6.0
uniform float compositeFilterWidth; // Default: 1.5
uniform float phosphorIntensity; // Default: 0.25
uniform float scanlineIntensity; // Default: 0.12

in vec2 v_texCoords;
out vec4 fragColor;

// === CONSTANTS ===
const float PI = 3.14159265358979323846;
const float TAU = 6.28318530717958647692;

// NTSC color subcarrier: 3.579545 MHz
// At 640 pixels for ~52.6µs active video: cycles/pixel ≈ 0.2917
const float CC_PER_PIXEL = 0.2917;

// CGA specific: 14.318 MHz pixel clock = exactly 4× color subcarrier
// This means exactly 4 pixels per color cycle = 0.25 cycles per pixel
const float CGA_CC_PER_PIXEL = 0.25;

// Filter kernel radius (samples to each side)
const int FILTER_RADIUS = 12;

// === COLOR SPACE CONVERSION ===
// GLSL matrices are column-major
const mat3 RGB_TO_YIQ = mat3(
0.299,  0.596,  0.211,     // Column 0: R coefficients for Y,I,Q
0.587, -0.274, -0.523,     // Column 1: G coefficients
0.114, -0.322,  0.312      // Column 2: B coefficients
);

const mat3 YIQ_TO_RGB = mat3(
1.000,  1.000,  1.000,     // Column 0: Y coefficients for R,G,B
0.956, -0.272, -1.107,     // Column 1: I coefficients
0.621, -0.647,  1.704      // Column 2: Q coefficients
);

// === DEFAULT VALUES ===
// Used when uniforms aren't set (value of 0)
float getLumaFilter() {
    return lumaFilterWidth > 0.0 ? lumaFilterWidth : 1.15;
}
float getChromaIFilter() {
    return chromaIFilterWidth > 0.0 ? chromaIFilterWidth : 3.5;
}
float getChromaQFilter() {
    return chromaQFilterWidth > 0.0 ? chromaQFilterWidth : 6.0;
}
float getCompositeFilter() {
    return compositeFilterWidth > 0.0 ? compositeFilterWidth : 1.35;
}
float getPhosphorStrength() {
    return phosphorIntensity > 0.0 ? phosphorIntensity : 0.25;
}
float getScanlineStrength() {
    return scanlineIntensity > 0.0 ? scanlineIntensity : 0.12;
}
float getCgaSaturation() {
    return cgaSaturation > 0.0 ? cgaSaturation : 1.0;
}

// === HELPER FUNCTIONS ===

float gaussianWeight(float x, float sigma) {
    return exp(-0.5 * x * x / (sigma * sigma));
}

vec3 sampleTexture(vec2 uv) {
    return texture(u_texture, clamp(uv, 0.0, 1.0)).rgb;
}

float calcCarrierPhase(float pixelX, float pixelY, float frameOffset) {
    float phase = pixelX * TAU * CC_PER_PIXEL;
    phase += pixelY * PI;  // 180° per line (from 227.5 cycles/line)
    phase += frameOffset;
    return phase;
}

float encodeComposite(vec3 rgb, float phase) {
    vec3 yiq = RGB_TO_YIQ * rgb;
    return yiq.x + yiq.y * cos(phase) + yiq.z * sin(phase);
}

// === COMPOSITE SIGNAL DECODE ===
vec3 decodeComposite(vec2 uv, vec2 texelSize, float basePhase) {
    float compFilter = getCompositeFilter();
    float iFilter = getChromaIFilter();
    float qFilter = getChromaQFilter();

    float yAccum = 0.0, iAccum = 0.0, qAccum = 0.0;
    float yWeight = 0.0, iWeight = 0.0, qWeight = 0.0;

    for (int i = -FILTER_RADIUS; i <= FILTER_RADIUS; i++) {
        float offset = float(i);
        vec2 sampleUV = uv + vec2(offset * texelSize.x, 0.0);

        vec3 srcRGB = sampleTexture(sampleUV);
        float samplePhase = basePhase + offset * TAU * CC_PER_PIXEL;
        float composite = encodeComposite(srcRGB, samplePhase);

        // Low-pass for luma
        float yw = gaussianWeight(offset, compFilter);
        yAccum += composite * yw;
        yWeight += yw;

        // Demodulate and filter chroma
        float iw = gaussianWeight(offset, iFilter);
        float qw = gaussianWeight(offset, qFilter);

        iAccum += composite * cos(samplePhase) * 2.0 * iw;
        qAccum += composite * sin(samplePhase) * 2.0 * qw;

        iWeight += iw;
        qWeight += qw;
    }

    vec3 yiq = vec3(yAccum / yWeight, iAccum / iWeight, qAccum / qWeight);
    return YIQ_TO_RGB * yiq;
}

// === S-VIDEO SIGNAL DECODE ===
vec3 decodeSVideo(vec2 uv, vec2 texelSize, float basePhase) {
    float yFilter = getLumaFilter();
    float iFilter = getChromaIFilter();
    float qFilter = getChromaQFilter();

    float yAccum = 0.0, iAccum = 0.0, qAccum = 0.0;
    float yWeight = 0.0, iWeight = 0.0, qWeight = 0.0;

    for (int i = -FILTER_RADIUS; i <= FILTER_RADIUS; i++) {
        float offset = float(i);
        vec2 sampleUV = uv + vec2(offset * texelSize.x, 0.0);

        vec3 srcRGB = sampleTexture(sampleUV);
        vec3 yiq = RGB_TO_YIQ * srcRGB;

        float samplePhase = basePhase + offset * TAU * CC_PER_PIXEL;
        float chromaSignal = yiq.y * cos(samplePhase) + yiq.z * sin(samplePhase);

        // Luma is separate - no cross-color
        float yw = gaussianWeight(offset, yFilter);
        yAccum += yiq.x * yw;
        yWeight += yw;

        // Chroma demodulation
        float iw = gaussianWeight(offset, iFilter);
        float qw = gaussianWeight(offset, qFilter);

        iAccum += chromaSignal * cos(samplePhase) * 2.0 * iw;
        qAccum += chromaSignal * sin(samplePhase) * 2.0 * qw;

        iWeight += iw;
        qWeight += qw;
    }

    vec3 yiqOut = vec3(yAccum / yWeight, iAccum / iWeight, qAccum / qWeight);
    return YIQ_TO_RGB * yiqOut;
}

// === CGA COMPOSITE DECODE ===
// CGA has exactly 4 pixels per color cycle (14.318 MHz / 3.579545 MHz = 4)
// This creates the famous artifact colors from specific bit patterns
vec3 decodeCGAComposite(vec2 uv, vec2 texelSize, float pixelX, float pixelY) {
    // CGA-specific filter widths - slightly different from generic NTSC
    // CGA monitors typically had less filtering, making artifacts more pronounced
    float yFilter = 1.2;
    float chromaFilter = 2.5;

    // CGA color burst phase - this determines the base hue
    // Adjusted to match the canonical CGA artifact color palette
    float cgaPhaseOffset = cgaHue + PI * 0.5;  // Adjust for correct color alignment

    // CGA doesn't have the 227.5 cycle per line offset in the same way
    // The phase is more deterministic based on pixel position
    float basePhase = pixelX * TAU * CGA_CC_PER_PIXEL + cgaPhaseOffset;

    // Odd lines have 180° phase shift (creates the alternating pattern)
    if (mod(pixelY, 2.0) >= 1.0) {
        basePhase += PI;
    }

    float yAccum = 0.0, iAccum = 0.0, qAccum = 0.0;
    float yWeight = 0.0, chromaWeight = 0.0;

    // Use smaller filter radius for sharper CGA look
    const int CGA_RADIUS = 8;

    for (int i = -CGA_RADIUS; i <= CGA_RADIUS; i++) {
        float offset = float(i);
        vec2 sampleUV = uv + vec2(offset * texelSize.x, 0.0);

        // CGA outputs either black (0) or white (1) in 640x200 mode
        // Get the source value (treating as monochrome for artifact generation)
        vec3 srcRGB = sampleTexture(sampleUV);
        float srcLuma = dot(srcRGB, vec3(0.299, 0.587, 0.114));

        // For CGA artifact colors, we use the luma as the composite signal level
        // In reality, CGA outputs either 0V or ~0.7V for the two states
        float composite = srcLuma;

        float samplePhase = basePhase + offset * TAU * CGA_CC_PER_PIXEL;

        // Low-pass filter for luma
        float yw = gaussianWeight(offset, yFilter);
        yAccum += composite * yw;
        yWeight += yw;

        // Demodulate chroma
        float cw = gaussianWeight(offset, chromaFilter);
        iAccum += composite * cos(samplePhase) * 2.0 * cw;
        qAccum += composite * sin(samplePhase) * 2.0 * cw;
        chromaWeight += cw;
    }

    float y = yAccum / yWeight;
    float i = (iAccum / chromaWeight) * getCgaSaturation();
    float q = (qAccum / chromaWeight) * getCgaSaturation();

    // Convert to RGB
    vec3 rgb = YIQ_TO_RGB * vec3(y, i, q);

    return rgb;
}

// === TRINITRON PHOSPHOR MASK ===
vec3 trinitronMask(vec2 screenPos) {
    float strength = getPhosphorStrength();
    float outputX = screenPos.x * 2.0;  // 2x display scale
    float stripe = mod(outputX, 3.0);

    float bleed = 0.15;
    vec3 mask;

    if (stripe < 1.0) {
        mask = vec3(1.0, bleed, bleed);
    } else if (stripe < 2.0) {
        mask = vec3(bleed, 1.0, bleed);
    } else {
        mask = vec3(bleed, bleed, 1.0);
    }

    float compensation = 1.0 / (0.333 + 0.667 * bleed);
    mask *= compensation * 0.85;

    return mix(vec3(1.0), mask, strength);
}

// === SCANLINE MASK ===
float scanlineMask(vec2 screenPos) {
    float strength = getScanlineStrength();
    float outputY = screenPos.y * 2.0;  // 2x display scale

    float scanline = sin(outputY * PI);
    scanline = scanline * 0.5 + 0.5;
    scanline = pow(scanline, 0.4);

    return mix(1.0 - strength, 1.0, scanline);
}

// === MAIN ===
void main() {
    vec2 uv = v_texCoords;
    uv.x = mix(uv.x, 1.0 - uv.x, flip.x);
    uv.y = mix(uv.y, 1.0 - uv.y, flip.y);

    vec2 texelSize = 1.0 / resolution;
    float pixelX = uv.x * resolution.x;
    float pixelY = uv.y * resolution.y;

    // Frame phase for dot crawl (4-frame cycle)
    float framePhase = mod(time, 4.0) * PI * 0.5;
    float basePhase = calcCarrierPhase(pixelX, pixelY, framePhase);

    // Decode signal based on mode
    vec3 rgb;
    if (signalMode == 2) {
        // CGA Composite mode - deterministic artifact colors
        rgb = decodeCGAComposite(uv, texelSize, pixelX, pixelY);
    } else if (signalMode == 1) {
        rgb = decodeComposite(uv, texelSize, basePhase);
    } else {
        rgb = decodeSVideo(uv, texelSize, basePhase);
    }

    // CRT display effects
    vec2 screenPos = vec2(pixelX, pixelY);
//    rgb *= trinitronMask(screenPos);
//    rgb *= scanlineMask(screenPos);

    fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
