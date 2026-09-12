import { useEffect, useRef, FC } from "react";
import { Renderer, Program, Mesh, Triangle, Vec3 } from "ogl";

const vert = /* glsl */ `
  precision highp float;
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const frag = /* glsl */ `
  precision highp float;

  uniform float iTime;
  uniform vec3 iResolution;
  uniform float hover;
  uniform float rot;
  uniform float hoverIntensity;
  varying vec2 vUv;

  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
    p3 += dot(p3, p3.yxz + 19.19);
    return -1.0 + 2.0 * fract(vec3(
      p3.x + p3.y,
      p3.x + p3.z,
      p3.y + p3.z
    ) * p3.zyx);
  }

  float snoise3(vec3 p) {
    const float K1 = 0.333333333;
    const float K2 = 0.166666667;
    vec3 i = floor(p + (p.x + p.y + p.z) * K1);
    vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
    vec3 e = step(vec3(0.0), d0 - d0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec3 d1 = d0 - (i1 - K2);
    vec3 d2 = d0 - (i2 - K1);
    vec3 d3 = d0 - 0.5;
    vec4 h = max(0.6 - vec4(
      dot(d0, d0),
      dot(d1, d1),
      dot(d2, d2),
      dot(d3, d3)
    ), 0.0);
    vec4 n = h * h * h * h * vec4(
      dot(d0, hash33(i)),
      dot(d1, hash33(i + i1)),
      dot(d2, hash33(i + i2)),
      dot(d3, hash33(i + 1.0))
    );
    return dot(vec4(31.316), n);
  }

  const vec3 baseColor1 = vec3(1.0, 1.0, 1.0);
  const vec3 baseColor2 = vec3(0.55, 0.55, 0.55);
  const vec3 baseColor3 = vec3(0.08, 0.08, 0.08);
  const float innerRadius = 0.82;
  const float noiseScale = 0.65;

  float light1(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * attenuation);
  }

  float light2(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * dist * attenuation);
  }

  vec4 draw(vec2 uv) {
    float ang = atan(uv.y, uv.x);
    float len = length(uv);
    float invLen = len > 0.0 ? 1.0 / len : 0.0;

    float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
    float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0);
    float d0 = distance(uv, (r0 * invLen) * uv);
    float v0 = light1(1.0, 10.0, d0);
    v0 *= smoothstep(r0 * 1.05, r0, len);
    float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;

    float a = iTime * -1.0;
    vec2 pos = vec2(cos(a), sin(a)) * r0;
    float d = distance(uv, pos);
    float v1 = light2(1.5, 5.0, d);
    v1 *= light1(1.0, 50.0, d0);

    float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
    float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);

    vec3 col = mix(baseColor1, baseColor2, cl);
    col = mix(baseColor3, col, v0);
    col = (col + v1) * v2 * v3;
    col = clamp(col, 0.0, 1.0);

    // Brightness of the classic (glowing) orb, 0 = empty .. 1 = bright.
    float bright = max(max(col.r, col.g), col.b);
    // Thin, luminous WHITE ring on the black page.
    float coverage = clamp(bright * 1.6, 0.0, 1.0);

    return vec4(vec3(1.0), coverage);
  }

  vec4 mainImage(vec2 fragCoord) {
    vec2 center = iResolution.xy * 0.5;
    float size = min(iResolution.x, iResolution.y);
    vec2 uv = (fragCoord - center) / size * 2.0;

    float angle = rot;
    float s = sin(angle);
    float c = cos(angle);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

    uv.x += hover * hoverIntensity * 0.1 * sin(uv.y * 10.0 + iTime);
    uv.y += hover * hoverIntensity * 0.1 * sin(uv.x * 10.0 + iTime);

    return draw(uv);
  }

  void main() {
    vec2 fragCoord = vUv * iResolution.xy;
    vec4 col = mainImage(fragCoord);
    // Straight color; blend multiplies by alpha over the black page.
    gl_FragColor = col;
  }
`;

interface VoiceOrbProps {
  className?: string;
  /** When true, the orb animates like it's speaking (simulated frequencies). */
  speaking?: boolean;
}

export const VoiceOrb: FC<VoiceOrbProps> = ({ className, speaking = false }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number;
    let renderer: Renderer | null = null;
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    let program: Program | null = null;

    renderer = new Renderer({ alpha: true, premultipliedAlpha: false, antialias: true, dpr: window.devicePixelRatio || 1 });
    gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(gl.canvas);

    const geometry = new Triangle(gl);
    program = new Program(gl, {
      vertex: vert,
      fragment: frag,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Vec3(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height) },
        hover: { value: 0 },
        rot: { value: 0 },
        hoverIntensity: { value: 0 },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });

    const resize = () => {
      if (!container || !renderer || !gl || !program) return;
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w * dpr, h * dpr);
      (gl.canvas as HTMLCanvasElement).style.width = w + "px";
      (gl.canvas as HTMLCanvasElement).style.height = h + "px";
      program.uniforms.iResolution.value.set(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height);
    };
    window.addEventListener("resize", resize);
    resize();

    let currentRot = 0;
    let lastTime = 0;
    let level = 0;

    const update = (t: number) => {
      rafId = requestAnimationFrame(update);
      if (!program || !renderer || !gl) return;

      const dt = Math.min((t - lastTime) * 0.001, 0.05);
      lastTime = t;
      const time = t * 0.001;
      program.uniforms.iTime.value = time;

      // Simulate speech energy with a blend of arbitrary frequencies.
      let target = 0.04;
      if (speakingRef.current) {
        const s =
          0.5 +
          0.5 *
            Math.sin(time * 9.0) *
            Math.sin(time * 3.3 + 1.7) *
            Math.cos(time * 13.0 + 0.5);
        target = 0.25 + 0.75 * Math.abs(s);
      }
      level += (target - level) * 0.15;

      if (level > 0.05) currentRot += dt * (0.3 + level * 2.4);
      program.uniforms.rot.value = currentRot;
      program.uniforms.hover.value = Math.min(level * 2, 1);
      program.uniforms.hoverIntensity.value = Math.min(level * 0.9, 0.9);

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      renderer.render({ scene: mesh });
    };

    rafId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      if (gl?.canvas && container.contains(gl.canvas)) {
        try { container.removeChild(gl.canvas); } catch {}
      }
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <div ref={containerRef} className={className} />;
};

export default VoiceOrb;
