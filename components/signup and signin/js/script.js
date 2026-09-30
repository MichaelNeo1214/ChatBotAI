const root = ReactDOM.createRoot(document.getElementById('root'));
        
        function LoginSignupComponent() {
            const canvasRef = React.useRef(null);
            const [isLogin, setIsLogin] = React.useState(true);
            const [name, setName] = React.useState("");
            const [email, setEmail] = React.useState("");
            const [password, setPassword] = React.useState("");
            const [error, setError] = React.useState(null);
            const [busy, setBusy] = React.useState(false);

            // Already signed in? Nothing to do on this page.
            React.useEffect(() => {
                fetch("/api/auth/me", { credentials: "same-origin" })
                    .then(r => r.json())
                    .then(d => { if (d.user) window.location.replace("/"); })
                    .catch(() => {});
            }, []);

            const switchMode = (toLogin) => {
                setIsLogin(toLogin);
                setError(null);
                setPassword("");
            };

            const submit = async (e) => {
                e.preventDefault();
                if (busy) return;
                setBusy(true);
                setError(null);

                const endpoint = isLogin ? "/api/auth/login" : "/api/auth/signup";
                const payload = isLogin ? { email, password } : { name, email, password };

                try {
                    const res = await fetch(endpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "same-origin",
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json().catch(() => null);

                    if (!res.ok) {
                        setError((data && data.error && data.error.message) || "Something went wrong. Please try again.");
                        setBusy(false);
                        return;
                    }
                    window.location.assign("/");
                } catch (err) {
                    setError("Could not reach the server. Is it running?");
                    setBusy(false);
                }
            };

            const ErrorBanner = error ? (
                <div role="alert" className="auth-error">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 8v4M12 16h.01" />
                    </svg>
                    <span>{error}</span>
                </div>
            ) : null;

            // OAuth is not implemented yet; say so rather than showing a dead button.
            const notImplemented = () => setError("Social sign-in isn't available yet — use your email and password.");

            React.useEffect(() => {
                let active = true;
                let renderer;
                let geometry;
                let material;
                let scene;
                let camera;
                let animationId;

                const initThree = (THREE) => {
                    if (!canvasRef.current || !active) return;
                    const canvas = canvasRef.current;
                    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
                    renderer.setPixelRatio(window.devicePixelRatio);
                    renderer.setSize(window.innerWidth, window.innerHeight);

                    scene = new THREE.Scene();
                    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

                    const uniforms = {
                        u_time: { value: 0 },
                        u_resolution: { value: new THREE.Vector2(window.innerWidth * 2, window.innerHeight * 2) },
                        u_opacities: { value: [0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 1.0] },
                        u_colors: { value: [
                            new THREE.Vector3(1, 1, 1),
                            new THREE.Vector3(1, 1, 1),
                            new THREE.Vector3(1, 1, 1),
                            new THREE.Vector3(1, 1, 1),
                            new THREE.Vector3(1, 1, 1),
                            new THREE.Vector3(1, 1, 1)
                        ] },
                        u_total_size: { value: 20.0 },
                        u_dot_size: { value: 6.0 },
                        u_reverse: { value: 0 }
                    };

                    material = new THREE.ShaderMaterial({
                        vertexShader: `
                            precision mediump float;
                            uniform vec2 u_resolution;
                            out vec2 fragCoord;
                            void main() {
                                gl_Position = vec4(position, 1.0);
                                fragCoord = (position.xy + 1.0) * 0.5 * u_resolution;
                                fragCoord.y = u_resolution.y - fragCoord.y;
                            }
                        `,
                        fragmentShader: `
                            precision mediump float;
                            in vec2 fragCoord;

                            uniform float u_time;
                            uniform float u_opacities[10];
                            uniform vec3 u_colors[6];
                            uniform float u_total_size;
                            uniform float u_dot_size;
                            uniform vec2 u_resolution;
                            uniform int u_reverse;

                            out vec4 fragColor;

                            float PHI = 1.61803398874989484820459;
                            float random(vec2 xy) {
                                return fract(tan(distance(xy * PHI, xy) * 0.5) * xy.x);
                            }

                            void main() {
                                vec2 st = fragCoord.xy;
                                st.x -= abs(floor((mod(u_resolution.x, u_total_size) - u_dot_size) * 0.5));
                                st.y -= abs(floor((mod(u_resolution.y, u_total_size) - u_dot_size) * 0.5));

                                float opacity = step(0.0, st.x) * step(0.0, st.y);

                                vec2 st2 = vec2(int(st.x / u_total_size), int(st.y / u_total_size));

                                float frequency = 5.0;
                                float show_offset = random(st2);
                                float rand = random(st2 * floor((u_time / frequency) + show_offset + frequency));
                                opacity *= u_opacities[int(rand * 10.0)];
                                opacity *= 1.0 - step(u_dot_size / u_total_size, fract(st.x / u_total_size));
                                opacity *= 1.0 - step(u_dot_size / u_total_size, fract(st.y / u_total_size));

                                vec3 color = u_colors[int(show_offset * 6.0)];

                                float animation_speed_factor = 3.0;
                                vec2 center_grid = u_resolution / 2.0 / u_total_size;
                                float dist_from_center = distance(center_grid, st2);

                                float timing_offset_intro = dist_from_center * 0.01 + (random(st2) * 0.15);

                                float current_timing_offset = timing_offset_intro;
                                opacity *= step(current_timing_offset, u_time * animation_speed_factor);
                                opacity *= clamp((1.0 - step(current_timing_offset + 0.1, u_time * animation_speed_factor)) * 1.25, 1.0, 1.25);

                                fragColor = vec4(color, opacity);
                                fragColor.rgb *= fragColor.a;
                            }
                        `,
                        uniforms: uniforms,
                        glslVersion: THREE.GLSL3,
                        blending: THREE.CustomBlending,
                        blendSrc: THREE.SrcAlphaFactor,
                        blendDst: THREE.OneFactor,
                        transparent: true
                    });

                    geometry = new THREE.PlaneGeometry(2, 2);
                    const mesh = new THREE.Mesh(geometry, material);
                    scene.add(mesh);

                    const startTime = performance.now();
                    const animate = () => {
                        if (!active) return;
                        animationId = requestAnimationFrame(animate);
                        uniforms.u_time.value = (performance.now() - startTime) / 1000.0;
                        renderer.render(scene, camera);
                    };
                    animate();

                    const handleResize = () => {
                        renderer.setSize(window.innerWidth, window.innerHeight);
                        uniforms.u_resolution.value.set(window.innerWidth * 2, window.innerHeight * 2);
                    };
                    window.addEventListener('resize', handleResize);

                    return () => {
                        window.removeEventListener('resize', handleResize);
                    };
                };

                if (window.THREE) {
                    const cleanUp = initThree(window.THREE);
                    return () => {
                        active = false;
                        if (cleanUp) cleanUp();
                        if (animationId) cancelAnimationFrame(animationId);
                        if (renderer) renderer.dispose();
                        if (geometry) geometry.dispose();
                        if (material) material.dispose();
                    };
                }

                return () => {
                    active = false;
                    if (animationId) cancelAnimationFrame(animationId);
                    if (renderer) renderer.dispose();
                    if (geometry) geometry.dispose();
                    if (material) material.dispose();
                };
            }, []);

            const GoogleIcon = (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
            );
            const GitHubIcon = (
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.699-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.379.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.577.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
            );
            const AppleIcon = (
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.04 2.26-.79 3.59-.76 1.56.04 2.88.75 3.65 1.89-3.08 1.75-2.58 5.61.35 6.75-1.01 2.37-2.39 4.39-4.29 4.29zM12.03 7.25c-.15-2.23 1.66-4.07 3.72-4.25.36 2.38-1.92 4.34-3.72 4.25z" />
                </svg>
            );

            const Logo = (
                <div className="auth-logo" aria-hidden="true">JS</div>
            );
            const Footer = (
                <div className="auth-legal">
                    By proceeding, you agree to creating an account subject to our{" "}
                    <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.
                </div>
            );

            return (
                <div className="auth-page">
                    <canvas ref={canvasRef} className="auth-bg-canvas" aria-hidden="true" />
                    <div className="auth-scrim" aria-hidden="true" />

                    <div className="auth-card">
                        {isLogin ? (
                            <React.Fragment>
                                {Logo}
                                <h1 className="auth-title">Sign in to Account</h1>
                                <p className="auth-subtitle">Sign in to your Account.</p>

                                {ErrorBanner}
                                <form className="auth-form" onSubmit={submit}>
                                    <input className="auth-field" type="email" placeholder="name@work-email.com" autoComplete="email" required
                                        value={email} onChange={e => setEmail(e.target.value)} />
                                    <input className="auth-field" type="password" placeholder="Password" autoComplete="current-password" required
                                        value={password} onChange={e => setPassword(e.target.value)} />
                                    <button className="auth-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : "Continue with Email"}</button>
                                </form>

                                <div className="auth-divider">or</div>

                                <div className="auth-social">
                                    <button type="button" onClick={notImplemented} className="auth-social-btn">{GoogleIcon}Continue with Google</button>
                                    <button type="button" onClick={notImplemented} className="auth-social-btn">{GitHubIcon}Continue with GitHub</button>
                                    <button type="button" onClick={notImplemented} className="auth-social-btn">{AppleIcon}Continue with Apple</button>
                                </div>

                                <div className="auth-switch">
                                    Don't have an account?{" "}
                                    <button type="button" className="auth-link" onClick={() => switchMode(false)}>Sign Up</button>
                                </div>
                                {Footer}
                            </React.Fragment>
                        ) : (
                            <React.Fragment>
                                {Logo}
                                <h1 className="auth-title">Sign up for Account</h1>
                                <p className="auth-subtitle">Create a new account to get started.</p>

                                {ErrorBanner}
                                <form className="auth-form" onSubmit={submit}>
                                    <input className="auth-field" type="text" placeholder="Full Name" autoComplete="name" required
                                        value={name} onChange={e => setName(e.target.value)} />
                                    <input className="auth-field" type="email" placeholder="name@work-email.com" autoComplete="email" required
                                        value={email} onChange={e => setEmail(e.target.value)} />
                                    <input className="auth-field" type="password" placeholder="Password (at least 8 characters)" autoComplete="new-password" minLength={8} required
                                        value={password} onChange={e => setPassword(e.target.value)} />
                                    <button className="auth-submit" type="submit" disabled={busy}>{busy ? "Creating account…" : "Sign Up with Email"}</button>
                                </form>

                                <div className="auth-divider">or</div>

                                <div className="auth-social">
                                    <button type="button" onClick={notImplemented} className="auth-social-btn">{GoogleIcon}Sign up with Google</button>
                                    <button type="button" onClick={notImplemented} className="auth-social-btn">{GitHubIcon}Sign up with GitHub</button>
                                    <button type="button" onClick={notImplemented} className="auth-social-btn">{AppleIcon}Sign up with Apple</button>
                                </div>

                                <div className="auth-switch">
                                    Already have an account?{" "}
                                    <button type="button" className="auth-link" onClick={() => switchMode(true)}>Sign In</button>
                                </div>
                                {Footer}
                            </React.Fragment>
                        )}
                    </div>
                </div>
            );
        }

        root.render(<LoginSignupComponent />);