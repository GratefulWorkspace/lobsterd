import { useEffect, useRef, useState } from "react";

/* ═══════════════════════════════════════════
   HOOKS
   ═══════════════════════════════════════════ */

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);
  return scrolled;
}

/* ═══════════════════════════════════════════
   DATA
   ═══════════════════════════════════════════ */

const FEATURES = [
  {
    num: "01",
    name: "MICROVM ISOLATION",
    desc: "Each tenant runs in a Firecracker microVM with jailer enforcement — UID/GID namespacing, chroot, seccomp BPF (~35 syscalls), cgroup limits. Only 4 virtio devices remain. No vsock.",
    image: `${import.meta.env.BASE_URL}images/server-room.jpg`,
  },
  {
    num: "02",
    name: "INTELLIGENT SUSPEND",
    desc: "Auto-suspends idle VMs, auto-resumes on demand. CLI commands hold the VM awake mid-operation. Wake-on-request via TCP sentinel masks ~3s resume latency. Cron-aware scheduling wakes VMs before scheduled jobs.",
    image: `${import.meta.env.BASE_URL}images/control-panel.jpg`,
  },
  {
    num: "03",
    name: "SELF-HEALING WATCHDOG",
    desc: "State machine monitors every 10s: VM process, agent responsiveness, TAP device, gateway status, Caddy routes. Auto-repairs with configurable cooldowns and escalation paths.",
    image: `${import.meta.env.BASE_URL}images/watchdog-gauges.jpg`,
  },
  {
    num: "04",
    name: "NETWORK SECURITY",
    desc: "Per-tenant /30 subnet with dedicated TAP device. iptables chains at position 1 block cross-tenant traffic, RFC 1918, link-local. Connlimit and rate limiting per-tenant.",
    image: `${import.meta.env.BASE_URL}images/security-layers.jpg`,
  },
  {
    num: "05",
    name: "REST API",
    desc: "Full HTTP API mirroring every CLI command. Bearer token auth, auto-generated OpenAPI 3.1 spec. Spawn, evict, molt, snap — all available over HTTP.",
    image: `${import.meta.env.BASE_URL}images/buoy-beacon.jpg`,
  },
];

const COMMANDS = [
  {
    cmd: "init",
    args: "",
    desc: "Initialize the host",
    note: "deps, Caddy, config",
  },
  {
    cmd: "spawn",
    args: "<name>",
    desc: "Hatch a new tenant",
    note: "VM + overlay + TAP + SSH",
  },
  {
    cmd: "evict",
    args: "<name>",
    desc: "Remove a tenant",
    note: "destroy all resources",
  },
  {
    cmd: "molt",
    args: "[name]",
    desc: "Health-check & repair",
    note: "lobsters molt to grow",
  },
  { cmd: "tank", args: "", desc: "Live TUI dashboard", note: "aquarium view" },
  {
    cmd: "watch",
    args: "",
    desc: "Watchdog daemon",
    note: "auto-repair state machine",
  },
  {
    cmd: "suspend",
    args: "<name>",
    desc: "Suspend to disk",
    note: "cron-aware, frees RAM",
  },
  {
    cmd: "resume",
    args: "<name>",
    desc: "Resume in ~3s",
    note: "transparent to clients",
  },
  {
    cmd: "snap",
    args: "<name>",
    desc: "Snapshot overlay",
    note: "sparse tarball",
  },
  {
    cmd: "logs",
    args: "<name>",
    desc: "Stream logs",
    note: "real-time output",
  },
  {
    cmd: "buoy",
    args: "",
    desc: "REST API server",
    note: "HTTP mirror of CLI",
  },
  {
    cmd: "exec",
    args: "<name>",
    desc: "SSH into tenant",
    note: "ed25519 keypair",
  },
  {
    cmd: "configure",
    args: "<name>",
    desc: "OpenClaw config TUI",
    note: "auto-resumes if suspended",
  },
  {
    cmd: "devices",
    args: "<name>",
    desc: "List paired devices",
    note: "auto-resumes if suspended",
  },
];

const SECURITY_ITEMS = [
  { label: "SECCOMP BPF", value: "~35 allowed syscalls" },
  { label: "JAILER", value: "UID/GID namespace + chroot" },
  { label: "VIRTIO", value: "4 devices only, no vsock" },
  { label: "AGENT LOCKDOWN", value: "Root-only agent access" },
  { label: "IPTABLES", value: "Per-tenant chain isolation" },
  { label: "GUEST HARDENED", value: "No curl, wget, git, apk" },
];

const ARCH_LAYERS = [
  { label: "DOMAIN", value: "<name>.<domain>" },
  { label: "REVERSE PROXY", value: "Caddy + Auto-TLS" },
  { label: "GATEWAY", value: "OpenClaw :9000" },
  { label: "GUEST AGENT", value: "TCP :52 / :53" },
  { label: "GUEST OS", value: "Alpine 3.20 (overlay ext4)" },
  { label: "JAILER", value: "Firecracker + seccomp" },
  { label: "HOST", value: "Linux + KVM" },
];

const MARQUEE_ITEMS = [
  "SPAWN",
  "molt",
  "TANK",
  "suspend",
  "RESUME",
  "buoy",
  "SNAP",
  "evict",
];

const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

/* ═══════════════════════════════════════════
   BACKGROUND LAYERS
   ═══════════════════════════════════════════ */

function NoiseOverlay() {
  return (
    <svg
      aria-hidden="true"
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 9999, opacity: 0.04 }}
    >
      <filter id="noise">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.65"
          numOctaves="3"
          stitchTiles="stitch"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#noise)" />
    </svg>
  );
}

function GridLines() {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none">
      <div className="mx-auto max-w-[1600px] h-full relative">
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-px bg-dark/10"
            style={{ left: `${((i + 1) / 13) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   HEADER
   ═══════════════════════════════════════════ */

function Header() {
  const scrolled = useScrolled();
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 h-20 border-b transition-all duration-300"
      style={{
        backgroundColor: scrolled ? "rgba(235,235,232,0.9)" : "transparent",
        backdropFilter: scrolled ? "blur(12px)" : "none",
        borderColor: scrolled ? "#D4D4D8" : "transparent",
      }}
    >
      <div className="mx-auto max-w-[1600px] h-full px-8 flex items-center justify-between">
        <nav className="hidden md:flex gap-8">
          {["features", "commands", "security", "architecture"].map((id) => (
            <button
              type="button"
              key={id}
              onClick={() => scrollTo(id)}
              className="text-[10px] font-bold uppercase tracking-[0.25em] text-dark/50 hover:text-dark transition-colors duration-300 cursor-pointer"
            >
              {id}
            </button>
          ))}
        </nav>

        <div className="absolute left-1/2 -translate-x-1/2 flex items-baseline">
          <span
            style={{
              fontFamily: "'Playfair Display', serif",
              fontStyle: "italic",
            }}
            className="text-xl text-dark"
          >
            lobster
          </span>
          <span className="text-xl font-black text-dark">d</span>
        </div>

        <a
          href="https://github.com/tsconfigdotjson/lobsterd"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full border border-dark px-5 py-2 text-[10px] font-bold uppercase tracking-[0.25em] hover:bg-dark hover:text-warm transition-all duration-300 ease-expo cursor-pointer"
        >
          GitHub
        </a>
      </div>
    </header>
  );
}

/* ═══════════════════════════════════════════
   HERO
   ═══════════════════════════════════════════ */

function Hero() {
  const { ref, inView } = useInView(0.1);

  const stagger = (delay: number) => ({
    opacity: inView ? 1 : 0,
    transform: inView ? "translateY(0)" : "translateY(24px)",
    transition: `all 1s ${EXPO} ${delay}ms`,
  });

  const staggerX = (delay: number) => ({
    opacity: inView ? 1 : 0,
    transform: inView ? "translateX(0)" : "translateX(40px)",
    transition: `all 1.2s ${EXPO} ${delay}ms`,
  });

  return (
    <section ref={ref} className="min-h-screen pt-20 border-b border-[#D4D4D8]">
      <div className="mx-auto max-w-[1600px] px-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center min-h-[calc(100vh-80px)]">
        {/* Left side */}
        <div className="lg:col-span-7 py-16 lg:py-24">
          {/* Status pill */}
          <div
            className="inline-flex items-center gap-2.5 mb-12"
            style={stagger(0)}
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/50">
              Available for Research
            </span>
          </div>

          {/* Massive heading */}
          <div>
            <div style={stagger(100)}>
              <span className="block text-[clamp(4rem,10vw,10rem)] font-black leading-[0.85] tracking-[-0.05em] stroke-text">
                SPAWN
              </span>
            </div>
            <div style={stagger(200)}>
              <span
                className="block text-[clamp(4rem,10vw,10rem)] leading-[0.85] tracking-[-0.03em] text-dark"
                style={{
                  fontFamily: "'Playfair Display', serif",
                  fontStyle: "italic",
                }}
              >
                Isolate
              </span>
            </div>
            <div style={stagger(300)}>
              <span className="block text-[clamp(4rem,10vw,10rem)] font-black leading-[0.85] tracking-[-0.05em] stroke-text">
                ORCHESTRATE
              </span>
            </div>
          </div>

          {/* Technical readout */}
          <div
            className="mt-12 flex flex-wrap gap-x-6 gap-y-2"
            style={stagger(500)}
          >
            <span
              className="text-[10px] font-bold uppercase tracking-[0.2em] text-dark/35"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              Firecracker MicroVM
            </span>
            <span className="text-[10px] text-dark/15">{"//"}</span>
            <span
              className="text-[10px] font-bold uppercase tracking-[0.2em] text-dark/35"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              OpenClaw Gateway
            </span>
            <span className="text-[10px] text-dark/15">{"//"}</span>
            <span
              className="text-[10px] font-bold uppercase tracking-[0.2em] text-dark/35"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              KVM Isolation
            </span>
          </div>

          {/* CTA */}
          <div className="mt-12" style={stagger(600)}>
            <a
              href="https://github.com/tsconfigdotjson/lobsterd"
              className="group inline-flex items-center gap-4 border border-dark px-8 py-4 text-[11px] font-bold uppercase tracking-[0.25em] hover:bg-dark hover:text-warm transition-all duration-500 ease-expo cursor-pointer"
            >
              Get Started
              <svg
                aria-hidden="true"
                className="w-4 h-4 transition-transform duration-500 ease-expo group-hover:rotate-45"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M1 15L15 1M15 1H5M15 1V11" />
              </svg>
            </a>
          </div>
        </div>

        {/* Right side — Image */}
        <div
          className="lg:col-span-5 lg:self-start lg:pt-36"
          style={staggerX(400)}
        >
          <div className="relative border border-[#D4D4D8] p-4">
            <img
              src={`${import.meta.env.BASE_URL}images/hero-claw.jpg`}
              alt="Mechanical lobster claw — brushed steel and copper"
              className="w-full aspect-[15/10] object-cover grayscale"
            />
            {/* Glassmorphism status card */}
            <div className="absolute bottom-7 left-7 right-7 bg-dark/30 backdrop-blur-xl border border-white/10 p-5 opacity-90">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-warm/50">
                  System Status
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-green-400">
                    Operational
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div
                    className="text-[9px] uppercase tracking-[0.2em] text-warm/35"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    Tenants
                  </div>
                  <div className="text-xl font-black text-warm mt-1">12</div>
                </div>
                <div>
                  <div
                    className="text-[9px] uppercase tracking-[0.2em] text-warm/35"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    Healthy
                  </div>
                  <div className="text-xl font-black text-green-400 mt-1">
                    11
                  </div>
                </div>
                <div>
                  <div
                    className="text-[9px] uppercase tracking-[0.2em] text-warm/35"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    Suspended
                  </div>
                  <div className="text-xl font-black text-accent mt-1">1</div>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-3">
                  <span
                    className="text-[9px] uppercase tracking-[0.2em] text-warm/35 w-10"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    CPU
                  </span>
                  <div className="flex-1 h-[3px] bg-warm/10 overflow-hidden">
                    <div
                      className="h-full bg-accent"
                      style={{ width: "34%" }}
                    />
                  </div>
                  <span
                    className="text-[9px] text-warm/35"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    34%
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="text-[9px] uppercase tracking-[0.2em] text-warm/35 w-10"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    MEM
                  </span>
                  <div className="flex-1 h-[3px] bg-warm/10 overflow-hidden">
                    <div
                      className="h-full bg-accent"
                      style={{ width: "67%" }}
                    />
                  </div>
                  <span
                    className="text-[9px] text-warm/35"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    67%
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════
   MARQUEE
   ═══════════════════════════════════════════ */

function MarqueeTicker() {
  const renderSet = (offset: number) =>
    MARQUEE_ITEMS.map((item, i) => {
      const isStroke = i % 2 === 0;
      return (
        <div
          key={`${offset}-${i}`}
          className="flex items-center gap-10 shrink-0"
        >
          {isStroke ? (
            <span className="text-7xl font-black tracking-tight stroke-text">
              {item}
            </span>
          ) : (
            <span
              className="text-7xl tracking-tight text-dark"
              style={{
                fontFamily: "'Playfair Display', serif",
                fontStyle: "italic",
              }}
            >
              {item}
            </span>
          )}
          <span className="text-accent text-2xl">&#10022;</span>
        </div>
      );
    });

  return (
    <div className="w-full h-[120px] bg-surface border-b border-[#D4D4D8] overflow-hidden flex items-center">
      <div className="animate-marquee flex items-center gap-10 will-change-transform">
        {renderSet(0)}
        {renderSet(1)}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   FEATURES
   ═══════════════════════════════════════════ */

interface Feature {
  num: string;
  name: string;
  desc: string;
  image: string;
}

function FeatureRow({ feature, index }: { feature: Feature; index: number }) {
  const [hovered, setHovered] = useState(false);
  const { ref, inView } = useInView(0.1);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only visual effect, not interactive
    <div
      ref={ref}
      className="group relative border-b border-[#D4D4D8] cursor-pointer overflow-hidden"
      style={{
        height: 280,
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(24px)",
        transition: `all 0.8s ${EXPO} ${index * 100}ms`,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Clip-path image reveal */}
      <div
        className="absolute right-0 top-0 h-full w-1/2 overflow-hidden"
        style={{
          clipPath: hovered ? "inset(0 0 0 0)" : "inset(0 0 0 100%)",
          transition: `clip-path 0.15s ${EXPO}`,
        }}
      >
        <img
          src={feature.image}
          alt=""
          className="h-full w-full object-cover grayscale"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-accent/10 mix-blend-multiply" />
      </div>

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-[1600px] px-8 h-full flex items-center">
        <div className="flex items-center gap-8 w-full">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/25 shrink-0"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {feature.num}
          </span>
          <div className="flex-1 min-w-0">
            <h3
              className="text-3xl lg:text-4xl font-black tracking-[-0.03em]"
              style={{
                fontStyle: hovered ? "italic" : "normal",
                fontFamily: hovered
                  ? "'Playfair Display', serif"
                  : "'Inter', sans-serif",
                fontWeight: hovered ? 400 : 900,
              }}
            >
              {feature.name}
            </h3>
            <p className="mt-3 text-sm text-dark/50 max-w-xl leading-relaxed">
              {feature.desc}
            </p>
          </div>
          {/* View circle */}
          <div
            className="w-14 h-14 rounded-full border border-dark flex items-center justify-center shrink-0 hidden lg:flex"
            style={{
              opacity: hovered ? 1 : 0,
              transform: hovered ? "scale(1)" : "scale(0.5)",
              transition: `all 0.5s ${EXPO}`,
            }}
          >
            <svg
              aria-hidden="true"
              className="w-3.5 h-3.5"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M1 15L15 1M15 1H5M15 1V11" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

function Features() {
  return (
    <section id="features" className="border-b border-[#D4D4D8]">
      <div className="mx-auto max-w-[1600px] px-8 py-20">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35">
            Core Capabilities
          </span>
          <span
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            005 Features
          </span>
        </div>
      </div>
      {FEATURES.map((f, i) => (
        <FeatureRow key={f.num} feature={f} index={i} />
      ))}
    </section>
  );
}

/* ═══════════════════════════════════════════
   PHILOSOPHY INTERSTITIAL
   ═══════════════════════════════════════════ */

function Philosophy() {
  const { ref, inView } = useInView(0.2);

  return (
    <section className="border-b border-[#D4D4D8] py-28 lg:py-40 overflow-hidden">
      <div
        ref={ref}
        className="mx-auto max-w-[1600px] px-8 text-center"
        style={{
          opacity: inView ? 1 : 0,
          transform: inView ? "translateY(0)" : "translateY(40px)",
          transition: `all 1.2s ${EXPO}`,
        }}
      >
        <p
          className="text-[clamp(2rem,5vw,5rem)] leading-[1.1] tracking-[-0.03em] text-dark"
          style={{
            fontFamily: "'Playfair Display', serif",
            fontStyle: "italic",
          }}
        >
          The strongest isolation is
          <br />
          the kind you{" "}
          <span
            className="stroke-text-accent font-black"
            style={{ fontFamily: "'Inter', sans-serif", fontStyle: "normal" }}
          >
            never
          </span>{" "}
          think about.
        </p>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════
   COMMANDS
   ═══════════════════════════════════════════ */

function Commands() {
  const { ref, inView } = useInView(0.1);

  return (
    <section id="commands" className="border-b border-[#D4D4D8]">
      <div className="mx-auto max-w-[1600px] px-8 py-20">
        <div className="flex items-baseline justify-between mb-16">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35">
            Command Line Interface
          </span>
          <span
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            014 Commands
          </span>
        </div>
      </div>

      <div
        ref={ref}
        className="mx-auto max-w-[1600px] px-8 pb-20"
        style={{
          opacity: inView ? 1 : 0,
          transform: inView ? "translateY(0)" : "translateY(20px)",
          transition: `all 1s ${EXPO}`,
        }}
      >
        <div className="bg-dark border border-[#D4D4D8]/10 p-8 lg:p-12">
          {/* Terminal chrome */}
          <div className="flex items-center gap-2 mb-8 pb-4 border-b border-warm/10">
            <span className="w-3 h-3 rounded-full bg-accent/80" />
            <span className="w-3 h-3 rounded-full bg-warm/15" />
            <span className="w-3 h-3 rounded-full bg-warm/15" />
            <span
              className="ml-4 text-[10px] uppercase tracking-[0.2em] text-warm/25"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              lobsterd &mdash; bash &mdash; 80&times;24
            </span>
          </div>

          {/* Commands grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-1">
            {COMMANDS.map((c, i) => (
              <div
                key={c.cmd}
                className="group py-3.5 border-b border-warm/5"
                style={{
                  opacity: inView ? 1 : 0,
                  transform: inView ? "translateY(0)" : "translateY(8px)",
                  transition: `all 0.6s ${EXPO} ${i * 40}ms`,
                }}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className="text-accent text-sm"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    $
                  </span>
                  <span
                    className="text-warm font-bold text-sm"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    lobsterd {c.cmd}
                  </span>
                  {c.args && (
                    <span
                      className="text-warm/35 text-sm"
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {c.args}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-4">
                  <span className="text-warm/45 text-xs">{c.desc}</span>
                  <span
                    className="text-[9px] uppercase tracking-[0.15em] text-warm/15 shrink-0"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {c.note}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════
   SECURITY
   ═══════════════════════════════════════════ */

function Security() {
  const { ref, inView } = useInView(0.1);

  return (
    <section
      id="security"
      className="relative border-b border-[#D4D4D8] overflow-hidden"
    >
      {/* Background image */}
      <div
        className="absolute inset-0 bg-cover bg-center grayscale"
        style={{
          backgroundImage: `url(${import.meta.env.BASE_URL}images/security-layers.jpg)`,
          opacity: 0.07,
        }}
      />

      <div className="relative z-10 mx-auto max-w-[1600px] px-8 py-28 lg:py-36">
        <div className="flex items-baseline justify-between mb-16">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35">
            Security &amp; Research
          </span>
          <span
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            Defense in Depth
          </span>
        </div>

        <div
          ref={ref}
          className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8"
        >
          {/* Left — heading */}
          <div className="lg:col-span-5">
            <h2
              className="text-[clamp(2.5rem,4vw,4.5rem)] leading-[1.05] tracking-[-0.02em]"
              style={{
                fontFamily: "'Playfair Display', serif",
                fontStyle: "italic",
                opacity: inView ? 1 : 0,
                transform: inView ? "translateY(0)" : "translateY(24px)",
                transition: `all 1s ${EXPO}`,
              }}
            >
              Built for isolation.
              <br />
              Hardened for <span className="text-accent">research.</span>
            </h2>
            <p
              className="mt-8 text-sm text-dark/50 leading-relaxed max-w-md"
              style={{
                opacity: inView ? 1 : 0,
                transform: inView ? "translateY(0)" : "translateY(16px)",
                transition: `all 1s ${EXPO} 200ms`,
              }}
            >
              Every VM is a hardened sandbox. Study isolation boundaries, test
              attack surfaces, run adversarial agents safely. Enterprise-grade
              security meets computer security research.
            </p>
          </div>

          {/* Right — security grid */}
          <div className="lg:col-span-6 lg:col-start-7">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-[#D4D4D8]">
              {SECURITY_ITEMS.map((item, i) => (
                <div
                  key={item.label}
                  className="bg-warm p-7"
                  style={{
                    opacity: inView ? 1 : 0,
                    transform: inView ? "translateY(0)" : "translateY(20px)",
                    transition: `all 0.7s ${EXPO} ${(i + 1) * 80}ms`,
                  }}
                >
                  <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-accent">
                    {item.label}
                  </span>
                  <p
                    className="mt-3 text-sm text-dark/60"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {item.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════
   ARCHITECTURE
   ═══════════════════════════════════════════ */

function Architecture() {
  const { ref, inView } = useInView(0.1);

  return (
    <section
      id="architecture"
      className="relative border-b border-[#D4D4D8] overflow-hidden"
    >
      {/* Background */}
      <div
        className="absolute inset-0 bg-cover bg-center grayscale"
        style={{
          backgroundImage: `url(${import.meta.env.BASE_URL}images/lobster-traps.jpg)`,
          opacity: 0.05,
        }}
      />

      <div className="relative z-10 mx-auto max-w-[1600px] px-8 py-28 lg:py-36">
        <div className="flex items-baseline justify-between mb-16">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35">
            Architecture
          </span>
          <span
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/35"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            The Stack
          </span>
        </div>

        <div
          ref={ref}
          className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8"
        >
          {/* Left */}
          <div className="lg:col-span-5">
            <h2
              className="text-4xl lg:text-5xl font-black tracking-[-0.04em]"
              style={{
                opacity: inView ? 1 : 0,
                transform: inView ? "translateY(0)" : "translateY(24px)",
                transition: `all 1s ${EXPO}`,
              }}
            >
              Seven layers.
              <br />
              <span
                style={{
                  fontFamily: "'Playfair Display', serif",
                  fontStyle: "italic",
                  fontWeight: 400,
                }}
              >
                One command.
              </span>
            </h2>
            <p
              className="mt-8 text-sm text-dark/50 leading-relaxed max-w-md"
              style={{
                opacity: inView ? 1 : 0,
                transform: inView ? "translateY(0)" : "translateY(16px)",
                transition: `all 1s ${EXPO} 200ms`,
              }}
            >
              <code
                className="text-accent"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                lobsterd spawn my-tenant
              </code>{" "}
              provisions the entire stack — from KVM host to public domain — in
              seconds. Overlay filesystem, TAP device, SSH keys, Caddy route,
              OpenClaw gateway. All isolated. All automated.
            </p>
          </div>

          {/* Right — stack diagram */}
          <div className="lg:col-span-6 lg:col-start-7">
            <div className="border border-[#D4D4D8]">
              {ARCH_LAYERS.map((layer, i) => (
                <div
                  key={layer.label}
                  className="flex items-center justify-between px-6 lg:px-8 py-5 border-b border-[#D4D4D8] last:border-b-0"
                  style={{
                    opacity: inView ? 1 : 0,
                    transform: inView ? "translateX(0)" : "translateX(24px)",
                    transition: `all 0.7s ${EXPO} ${i * 70}ms`,
                  }}
                >
                  <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-dark/30">
                    {layer.label}
                  </span>
                  <span
                    className="text-sm text-dark"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {layer.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════
   FOOTER
   ═══════════════════════════════════════════ */

function Footer() {
  return (
    <footer className="relative bg-dark text-warm overflow-hidden">
      {/* Ghost marquee text */}
      <div className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none select-none">
        <span className="text-[20vw] font-black whitespace-nowrap tracking-[-0.05em] text-warm/[0.03]">
          LOBSTERD
        </span>
      </div>

      <div className="relative z-10 mx-auto max-w-[1600px] px-8 py-20 lg:py-28">
        {/* Large CTA */}
        <a
          href="https://github.com/tsconfigdotjson/lobsterd"
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-4 cursor-pointer"
        >
          <span className="text-3xl lg:text-4xl font-bold tracking-[-0.02em] border-b-2 border-transparent group-hover:border-accent transition-all duration-500 ease-expo">
            View on GitHub
          </span>
          <svg
            aria-hidden="true"
            className="w-5 h-5 lg:w-6 lg:h-6 transition-transform duration-500 ease-expo group-hover:translate-x-2"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M1 8H15M15 8L9 2M15 8L9 14" />
          </svg>
        </a>

        <p className="mt-8 text-sm text-warm/35 max-w-lg leading-relaxed">
          Open source microVM orchestrator for OpenClaw. Manage isolated tenants
          with Firecracker, Caddy, and a crustacean-themed CLI that takes
          security seriously.
        </p>

        {/* Bottom bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mt-20 lg:mt-28 pt-8 border-t border-warm/10">
          <div className="flex items-center gap-3">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-warm/35">
              System Operational
            </span>
          </div>
          <div className="flex items-center gap-6">
            <span className="text-[10px] uppercase tracking-[0.25em] text-warm/20">
              MIT License
            </span>
            <span className="text-[10px] uppercase tracking-[0.25em] text-warm/20">
              &copy; 2026 lobsterd
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}

/* ═══════════════════════════════════════════
   APP
   ═══════════════════════════════════════════ */

function App() {
  return (
    <div
      className="relative bg-warm text-dark"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      <NoiseOverlay />
      <GridLines />
      <Header />
      <main>
        <Hero />
        <MarqueeTicker />
        <Features />
        <Philosophy />
        <Commands />
        <Security />
        <Architecture />
      </main>
      <Footer />
    </div>
  );
}

export default App;
