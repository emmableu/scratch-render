const twgl = require('twgl.js');


class ShaderManager {
    /**
     * @param {WebGLRenderingContext} gl WebGL rendering context to create shaders for
     * @constructor
     */
    constructor (gl) {
        this._gl = gl;

        /**
         * The cache of all shaders compiled so far, filled on demand.
         * @type {Object<ShaderManager.DRAW_MODE, Array<ProgramInfo>>}
         * @private
         */
        this._shaderCache = {};
        for (const modeName in ShaderManager.DRAW_MODE) {
            if (ShaderManager.DRAW_MODE.hasOwnProperty(modeName)) {
                this._shaderCache[modeName] = [];
            }
        }
    }

    /**
     * Fetch the shader for a particular set of active effects.
     * Build the shader if necessary.
     * @param {ShaderManager.DRAW_MODE} drawMode Draw normally, silhouette, etc.
     * @param {int} effectBits Bitmask representing the enabled effects.
     * @returns {ProgramInfo} The shader's program info.
     */
    getShader (drawMode, effectBits) {
        const cache = this._shaderCache[drawMode];
        if (drawMode === ShaderManager.DRAW_MODE.silhouette) {
            // Silhouette mode isn't affected by these effects.
            effectBits &= ~(ShaderManager.EFFECT_INFO.color.mask | ShaderManager.EFFECT_INFO.brightness.mask);
        }
        let shader = cache[effectBits];
        if (!shader) {
            shader = cache[effectBits] = this._buildShader(drawMode, effectBits);
        }
        return shader;
    }

    /**
     * Build the shader for a particular set of active effects.
     * @param {ShaderManager.DRAW_MODE} drawMode Draw normally, silhouette, etc.
     * @param {int} effectBits Bitmask representing the enabled effects.
     * @returns {ProgramInfo} The new shader's program info.
     * @private
     */
    _buildShader (drawMode, effectBits) {
        const numEffects = ShaderManager.EFFECTS.length;

        const defines = [
            `#define DRAW_MODE_${drawMode}`
        ];
        for (let index = 0; index < numEffects; ++index) {
            if ((effectBits & (1 << index)) !== 0) {
                defines.push(`#define ENABLE_${ShaderManager.EFFECTS[index]}`);
            }
        }

        const definesText = `${defines.join('\n')}\n`;

        /* eslint-disable global-require */
        const vsFullText = `${definesText}precision mediump float;

#ifdef DRAW_MODE_line
uniform vec2 u_stageSize;
uniform float u_lineThickness;
uniform vec4 u_penPoints;

// Add this to divisors to prevent division by 0, which results in NaNs propagating through calculations.
// Smaller values can cause problems on some mobile devices.
const float epsilon = 1e-3;
#endif

#ifndef DRAW_MODE_line
uniform mat4 u_projectionMatrix;
uniform mat4 u_modelMatrix;
attribute vec2 a_texCoord;
#endif

attribute vec2 a_position;

varying vec2 v_texCoord;

void main() {
\t#ifdef DRAW_MODE_line
\t// Calculate a rotated ("tight") bounding box around the two pen points.
\t// Yes, we're doing this 6 times (once per vertex), but on actual GPU hardware,
\t// it's still faster than doing it in JS combined with the cost of uniformMatrix4fv.

\t// Expand line bounds by sqrt(2) / 2 each side-- this ensures that all antialiased pixels
\t// fall within the quad, even at a 45-degree diagonal
\tvec2 position = a_position;
\tfloat expandedRadius = (u_lineThickness * 0.5) + 1.4142135623730951;

\tfloat lineLength = length(u_penPoints.zw - u_penPoints.xy);

\tposition.x *= lineLength + (2.0 * expandedRadius);
\tposition.y *= 2.0 * expandedRadius;

\t// Center around first pen point
\tposition -= expandedRadius;

\t// Rotate quad to line angle
\tvec2 normalized = (u_penPoints.zw - u_penPoints.xy + epsilon) / (lineLength + epsilon);
\tposition = mat2(normalized.x, normalized.y, -normalized.y, normalized.x) * position;
\t// Translate quad
\tposition += u_penPoints.xy;

\t// Apply view transform
\tposition *= 2.0 / u_stageSize;

\tgl_Position = vec4(position, 0, 1);
\tv_texCoord = position * 0.5 * u_stageSize;
\t#else
\tgl_Position = u_projectionMatrix * u_modelMatrix * vec4(a_position, 0, 1);
\tv_texCoord = a_texCoord;
\t#endif
}
`;
        const fsFullText = `${definesText}precision mediump float;

#ifdef DRAW_MODE_silhouette
uniform vec4 u_silhouetteColor;
#else // DRAW_MODE_silhouette
# ifdef ENABLE_color
uniform float u_color;
# endif // ENABLE_color
# ifdef ENABLE_brightness
uniform float u_brightness;
# endif // ENABLE_brightness
#endif // DRAW_MODE_silhouette

#ifdef DRAW_MODE_colorMask
uniform vec3 u_colorMask;
uniform float u_colorMaskTolerance;
#endif // DRAW_MODE_colorMask

#ifdef ENABLE_fisheye
uniform float u_fisheye;
#endif // ENABLE_fisheye
#ifdef ENABLE_whirl
uniform float u_whirl;
#endif // ENABLE_whirl
#ifdef ENABLE_pixelate
uniform float u_pixelate;
uniform vec2 u_skinSize;
#endif // ENABLE_pixelate
#ifdef ENABLE_mosaic
uniform float u_mosaic;
#endif // ENABLE_mosaic
#ifdef ENABLE_ghost
uniform float u_ghost;
#endif // ENABLE_ghost

#ifdef DRAW_MODE_line
uniform vec4 u_lineColor;
uniform float u_lineThickness;
uniform vec4 u_penPoints;
#endif // DRAW_MODE_line

uniform sampler2D u_skin;

varying vec2 v_texCoord;

// Add this to divisors to prevent division by 0, which results in NaNs propagating through calculations.
// Smaller values can cause problems on some mobile devices.
const float epsilon = 1e-3;

#if !defined(DRAW_MODE_silhouette) && (defined(ENABLE_color))
// Branchless color conversions based on code from:
// http://www.chilliant.com/rgb2hsv.html by Ian Taylor
// Based in part on work by Sam Hocevar and Emil Persson
// See also: https://en.wikipedia.org/wiki/HSL_and_HSV#Formal_derivation


// Convert an RGB color to Hue, Saturation, and Value.
// All components of input and output are expected to be in the [0,1] range.
vec3 convertRGB2HSV(vec3 rgb)
{
\t// Hue calculation has 3 cases, depending on which RGB component is largest, and one of those cases involves a "mod"
\t// operation. In order to avoid that "mod" we split the M==R case in two: one for G<B and one for B>G. The B>G case
\t// will be calculated in the negative and fed through abs() in the hue calculation at the end.
\t// See also: https://en.wikipedia.org/wiki/HSL_and_HSV#Hue_and_chroma
\tconst vec4 hueOffsets = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);

\t// temp1.xy = sort B & G (largest first)
\t// temp1.z = the hue offset we'll use if it turns out that R is the largest component (M==R)
\t// temp1.w = the hue offset we'll use if it turns out that R is not the largest component (M==G or M==B)
\tvec4 temp1 = rgb.b > rgb.g ? vec4(rgb.bg, hueOffsets.wz) : vec4(rgb.gb, hueOffsets.xy);

\t// temp2.x = the largest component of RGB ("M" / "Max")
\t// temp2.yw = the smaller components of RGB, ordered for the hue calculation (not necessarily sorted by magnitude!)
\t// temp2.z = the hue offset we'll use in the hue calculation
\tvec4 temp2 = rgb.r > temp1.x ? vec4(rgb.r, temp1.yzx) : vec4(temp1.xyw, rgb.r);

\t// m = the smallest component of RGB ("min")
\tfloat m = min(temp2.y, temp2.w);

\t// Chroma = M - m
\tfloat C = temp2.x - m;

\t// Value = M
\tfloat V = temp2.x;

\treturn vec3(
\t\tabs(temp2.z + (temp2.w - temp2.y) / (6.0 * C + epsilon)), // Hue
\t\tC / (temp2.x + epsilon), // Saturation
\t\tV); // Value
}

vec3 convertHue2RGB(float hue)
{
\tfloat r = abs(hue * 6.0 - 3.0) - 1.0;
\tfloat g = 2.0 - abs(hue * 6.0 - 2.0);
\tfloat b = 2.0 - abs(hue * 6.0 - 4.0);
\treturn clamp(vec3(r, g, b), 0.0, 1.0);
}

vec3 convertHSV2RGB(vec3 hsv)
{
\tvec3 rgb = convertHue2RGB(hsv.x);
\tfloat c = hsv.z * hsv.y;
\treturn rgb * c + hsv.z - c;
}
#endif // !defined(DRAW_MODE_silhouette) && (defined(ENABLE_color))

const vec2 kCenter = vec2(0.5, 0.5);

void main()
{
\t#ifndef DRAW_MODE_line
\tvec2 texcoord0 = v_texCoord;

\t#ifdef ENABLE_mosaic
\ttexcoord0 = fract(u_mosaic * texcoord0);
\t#endif // ENABLE_mosaic

\t#ifdef ENABLE_pixelate
\t{
\t\t// TODO: clean up "pixel" edges
\t\tvec2 pixelTexelSize = u_skinSize / u_pixelate;
\t\ttexcoord0 = (floor(texcoord0 * pixelTexelSize) + kCenter) / pixelTexelSize;
\t}
\t#endif // ENABLE_pixelate

\t#ifdef ENABLE_whirl
\t{
\t\tconst float kRadius = 0.5;
\t\tvec2 offset = texcoord0 - kCenter;
\t\tfloat offsetMagnitude = length(offset);
\t\tfloat whirlFactor = max(1.0 - (offsetMagnitude / kRadius), 0.0);
\t\tfloat whirlActual = u_whirl * whirlFactor * whirlFactor;
\t\tfloat sinWhirl = sin(whirlActual);
\t\tfloat cosWhirl = cos(whirlActual);
\t\tmat2 rotationMatrix = mat2(
\t\t\tcosWhirl, -sinWhirl,
\t\t\tsinWhirl, cosWhirl
\t\t);

\t\ttexcoord0 = rotationMatrix * offset + kCenter;
\t}
\t#endif // ENABLE_whirl

\t#ifdef ENABLE_fisheye
\t{
\t\tvec2 vec = (texcoord0 - kCenter) / kCenter;
\t\tfloat vecLength = length(vec);
\t\tfloat r = pow(min(vecLength, 1.0), u_fisheye) * max(1.0, vecLength);
\t\tvec2 unit = vec / vecLength;

\t\ttexcoord0 = kCenter + r * unit * kCenter;
\t}
\t#endif // ENABLE_fisheye

\tgl_FragColor = texture2D(u_skin, texcoord0);

\t#if defined(ENABLE_color) || defined(ENABLE_brightness)
\t// Divide premultiplied alpha values for proper color processing
\t// Add epsilon to avoid dividing by 0 for fully transparent pixels
\tgl_FragColor.rgb = clamp(gl_FragColor.rgb / (gl_FragColor.a + epsilon), 0.0, 1.0);

\t#ifdef ENABLE_color
\t{
\t\tvec3 hsv = convertRGB2HSV(gl_FragColor.xyz);

\t\t// this code forces grayscale values to be slightly saturated
\t\t// so that some slight change of hue will be visible
\t\tconst float minLightness = 0.11 / 2.0;
\t\tconst float minSaturation = 0.09;
\t\tif (hsv.z < minLightness) hsv = vec3(0.0, 1.0, minLightness);
\t\telse if (hsv.y < minSaturation) hsv = vec3(0.0, minSaturation, hsv.z);

\t\thsv.x = mod(hsv.x + u_color, 1.0);
\t\tif (hsv.x < 0.0) hsv.x += 1.0;

\t\tgl_FragColor.rgb = convertHSV2RGB(hsv);
\t}
\t#endif // ENABLE_color

\t#ifdef ENABLE_brightness
\tgl_FragColor.rgb = clamp(gl_FragColor.rgb + vec3(u_brightness), vec3(0), vec3(1));
\t#endif // ENABLE_brightness

\t// Re-multiply color values
\tgl_FragColor.rgb *= gl_FragColor.a + epsilon;

\t#endif // defined(ENABLE_color) || defined(ENABLE_brightness)

\t#ifdef ENABLE_ghost
\tgl_FragColor *= u_ghost;
\t#endif // ENABLE_ghost

\t#ifdef DRAW_MODE_silhouette
\t// Discard fully transparent pixels for stencil test
\tif (gl_FragColor.a == 0.0) {
\t\tdiscard;
\t}
\t// switch to u_silhouetteColor only AFTER the alpha test
\tgl_FragColor = u_silhouetteColor;
\t#else // DRAW_MODE_silhouette

\t#ifdef DRAW_MODE_colorMask
\tvec3 maskDistance = abs(gl_FragColor.rgb - u_colorMask);
\tvec3 colorMaskTolerance = vec3(u_colorMaskTolerance, u_colorMaskTolerance, u_colorMaskTolerance);
\tif (any(greaterThan(maskDistance, colorMaskTolerance)))
\t{
\t\tdiscard;
\t}
\t#endif // DRAW_MODE_colorMask
\t#endif // DRAW_MODE_silhouette

\t#ifdef DRAW_MODE_straightAlpha
\t// Un-premultiply alpha.
\tgl_FragColor.rgb /= gl_FragColor.a + epsilon;
\t#endif
  
\t#else // DRAW_MODE_line
\t// Maaaaagic antialiased-line-with-round-caps shader.
\t// Adapted from Inigo Quilez' 2D distance function cheat sheet
\t// https://www.iquilezles.org/www/articles/distfunctions2d/distfunctions2d.htm

\t// The xy component of u_penPoints is the first point; the zw is the second point.
\t// This is done to minimize the number of gl.uniform calls, which can add up.
\tvec2 pa = v_texCoord - u_penPoints.xy, ba = u_penPoints.zw - u_penPoints.xy;
\t// Magnitude of vector projection of this fragment onto the line (both relative to the line's start point).
\t// This results in a "linear gradient" which goes from 0.0 at the start point to 1.0 at the end point.
\tfloat projMagnitude = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);

\tfloat lineDistance = length(pa - (ba * projMagnitude));

\t// The distance to the line allows us to create lines of any thickness.
\t// Instead of checking whether this fragment's distance < the line thickness,
\t// utilize the distance field to get some antialiasing. Fragments far away from the line are 0,
\t// fragments close to the line are 1, and fragments that are within a 1-pixel border of the line are in between.
\tfloat cappedLine = clamp((u_lineThickness + 1.0) * 0.5 - lineDistance, 0.0, 1.0);

\tgl_FragColor = u_lineColor * cappedLine;
\t#endif // DRAW_MODE_line
}
`;
        /* eslint-enable global-require */

        return twgl.createProgramInfo(this._gl, [vsFullText, fsFullText]);
    }
}

/**
 * @typedef {object} ShaderManager.Effect
 * @prop {int} mask - The bit in 'effectBits' representing the effect.
 * @prop {function} converter - A conversion function which takes a Scratch value (generally in the range
 *   0..100 or -100..100) and maps it to a value useful to the shader. This
 *   mapping may not be reversible.
 * @prop {boolean} shapeChanges - Whether the effect could change the drawn shape.
 */

/**
 * Mapping of each effect name to info about that effect.
 * @enum {ShaderManager.Effect}
 */
ShaderManager.EFFECT_INFO = {
    /** Color effect */
    color: {
        uniformName: 'u_color',
        mask: 1 << 0,
        converter: x => (x / 200) % 1,
        shapeChanges: false
    },
    /** Fisheye effect */
    fisheye: {
        uniformName: 'u_fisheye',
        mask: 1 << 1,
        converter: x => Math.max(0, (x + 100) / 100),
        shapeChanges: true
    },
    /** Whirl effect */
    whirl: {
        uniformName: 'u_whirl',
        mask: 1 << 2,
        converter: x => -x * Math.PI / 180,
        shapeChanges: true
    },
    /** Pixelate effect */
    pixelate: {
        uniformName: 'u_pixelate',
        mask: 1 << 3,
        converter: x => Math.abs(x) / 10,
        shapeChanges: true
    },
    /** Mosaic effect */
    mosaic: {
        uniformName: 'u_mosaic',
        mask: 1 << 4,
        converter: x => {
            x = Math.round((Math.abs(x) + 10) / 10);
            /** @todo cap by Math.min(srcWidth, srcHeight) */
            return Math.max(1, Math.min(x, 512));
        },
        shapeChanges: true
    },
    /** Brightness effect */
    brightness: {
        uniformName: 'u_brightness',
        mask: 1 << 5,
        converter: x => Math.max(-100, Math.min(x, 100)) / 100,
        shapeChanges: false
    },
    /** Ghost effect */
    ghost: {
        uniformName: 'u_ghost',
        mask: 1 << 6,
        converter: x => 1 - (Math.max(0, Math.min(x, 100)) / 100),
        shapeChanges: false
    }
};

/**
 * The name of each supported effect.
 * @type {Array}
 */
ShaderManager.EFFECTS = Object.keys(ShaderManager.EFFECT_INFO);

/**
 * The available draw modes.
 * @readonly
 * @enum {string}
 */
ShaderManager.DRAW_MODE = {
    /**
     * Draw normally. Its output will use premultiplied alpha.
     */
    default: 'default',

    /**
     * Draw with non-premultiplied alpha. Useful for reading pixels from GL into an ImageData object.
     */
    straightAlpha: 'straightAlpha',

    /**
     * Draw a silhouette using a solid color.
     */
    silhouette: 'silhouette',

    /**
     * Draw only the parts of the drawable which match a particular color.
     */
    colorMask: 'colorMask',

    /**
     * Draw a line with caps.
     */
    line: 'line'
};

module.exports = ShaderManager;
