/*"use client";

import { useState, useRef, useEffect } from "react";

type PdfDoc = { name: string; size: number; pages: number; text: string };
type Segment = { start: number; end: number; text: string };
type Marker = { id: number; start: number; end: number; title: string; summary: string };
type Mode = "answer" | "markers" | "topics";
type Notice = { level: "error" | "warn" | "info"; text: string };
type ChunkResult = { text: string; segments: Segment[] };
type DictState = "idle" | "live" | "rec" | "busy";

const MAX_SECONDS = 7200; // 2 horas de grabación
const MAX_UPLOAD_SECONDS = 7500; // tolerancia al subir archivos
const WARN_REMAINING = 20 * 60;
const CHUNK_SECONDS = 120; // 120 s de WAV 16 kHz mono ≈ 3.8 MB, bajo el límite de 4.5 MB
const PEAK_STEP = 0.2;

const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = m.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Procesamiento de audio en el navegador ----------
async function decodeToMono(blob: Blob): Promise<{ samples: Int16Array; rate: number }> {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length;
    const chans = audio.numberOfChannels;
    const data: Float32Array[] = [];
    for (let c = 0; c < chans; c++) data.push(audio.getChannelData(c));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += data[c][i];
      s /= chans;
      s = Math.max(-1, Math.min(1, s));
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return { samples: out, rate: audio.sampleRate };
  } finally {
    ctx.close();
  }
}

function computePeaks(samples: Int16Array, rate: number): number[] {
  const w = Math.max(1, Math.floor(rate * PEAK_STEP));
  const n = Math.ceil(samples.length / w);
  const peaks = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    let m = 0;
    const end = Math.min(samples.length, (k + 1) * w);
    for (let j = k * w; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > m) m = a;
    }
    peaks[k] = Math.min(1, (m / 32768) * 3);
  }
  return peaks;
}

// Corta cada ~120 s, buscando el punto más silencioso para no partir palabras
function planChunks(peaks: number[], duration: number): [number, number][] {
  const plan: [number, number][] = [];
  let start = 0;
  while (duration - start > CHUNK_SECONDS) {
    const target = start + CHUNK_SECONDS;
    const fromIdx = Math.floor((target - 10) / PEAK_STEP);
    const toIdx = Math.floor(target / PEAK_STEP);
    let bestIdx = toIdx;
    let bestVal = Infinity;
    for (let i = fromIdx; i <= toIdx; i++) {
      const v = peaks[i] ?? 0;
      if (v < bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    const cut = Math.min(target, bestIdx * PEAK_STEP);
    plan.push([start, cut]);
    start = cut;
  }
  plan.push([start, duration]);
  return plan;
}

function wavBlob(samples: Int16Array, rate: number, from: number, to: number): Blob {
  const slice = samples.subarray(from, to);
  const len = slice.length * 2;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + len, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len, true);
  new Int16Array(buf, 44).set(slice);
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- Iconos ----------
const PlayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
);
const StopIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
);
const MicIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </svg>
);
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const Spinner = () => (
  <div className="h-4 w-4 animate-spin rounded-full border-2 border-violet-600 border-t-transparent" />
);

// ---------- Onda de audio ----------
function Waveform({
  peaks,
  version,
  duration,
  currentTime,
  markers,
  activeId,
  onSeek,
  live = false,
  height = 64,
}: {
  peaks: number[];
  version: number;
  duration: number;
  currentTime: number;
  markers: Marker[];
  activeId: number | null;
  onSeek?: (t: number) => void;
  live?: boolean;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const total = duration > 0 ? duration : peaks.length * PEAK_STEP || 1;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = height;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (live) {
      const n = Math.floor(w / 3);
      const slice = peaks.slice(-n);
      ctx.fillStyle = "#ef4444";
      slice.forEach((p, i) => {
        const bh = Math.max(2, p * h * 0.95);
        const x = w - (slice.length - i) * 3;
        ctx.fillRect(x, (h - bh) / 2, 2, bh);
      });
      return;
    }

    markers.forEach((m) => {
      ctx.fillStyle = m.id === activeId ? "rgba(139,92,246,0.35)" : "rgba(139,92,246,0.15)";
      ctx.fillRect((m.start / total) * w, 0, Math.max(((m.end - m.start) / total) * w, 2), h);
    });

    const bars = Math.max(1, Math.floor(w / 3));
    const playedX = (currentTime / total) * w;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i / bars) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let max = 0;
      for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j];
      const bh = Math.max(2, max * h * 0.95);
      const x = i * 3;
      ctx.fillStyle = x < playedX ? "#7c3aed" : "#a1a1aa";
      ctx.fillRect(x, (h - bh) / 2, 2, bh);
    }

    if (currentTime > 0) {
      ctx.fillStyle = "#7c3aed";
      ctx.fillRect(playedX, 0, 2, h);
    }
  }, [peaks, version, total, currentTime, markers, activeId, height, live]);

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height }}
      className={onSeek ? "cursor-pointer" : ""}
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * total);
      }}
    />
  );
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);

  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [audioReady, setAudioReady] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [transcribeError, setTranscribeError] = useState("");

  const [transcription, setTranscription] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [topicAnalysis, setTopicAnalysis] = useState("");
  const [mode, setMode] = useState<Mode>("answer");

  const [pdfDocs, setPdfDocs] = useState<PdfDoc[]>([]);
  const [readingPdf, setReadingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  // Onda, reproducción y marcas
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [markersLoading, setMarkersLoading] = useState(false);
  const [markersError, setMarkersError] = useState("");

  // Alertas
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState<{ groq: boolean; gemini: boolean } | null>(null);
  const [micLost, setMicLost] = useState(false);
  const [batteryLow, setBatteryLow] = useState(false);

  // Dictado
  const [dictState, setDictState] = useState<DictState>("idle");
  const [canDictate, setCanDictate] = useState(false);
  const recognitionRef = useRef<any>(null);
  const dictFallbackRef = useRef(false);
  const dictRecRef = useRef<MediaRecorder | null>(null);
  const dictTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveStartRef = useRef(0);
  const liveGotResultRef = useRef(false);
  const liveStoppedByUserRef = useRef(false);

  const peaksRef = useRef<number[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<Marker[]>([]);
  const activeRef = useRef<Marker | null>(null);

  const samplesRef = useRef<{ samples: Int16Array; rate: number } | null>(null);
  const planRef = useRef<[number, number][]>([]);
  const resultsRef = useRef<(ChunkResult | null)[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peakTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef(0);
  const wakeRef = useRef<any>(null);

  // ---------- Estado de red y salud de servicios ----------
  const checkHealth = async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  };

  useEffect(() => {
    setCanDictate(typeof MediaRecorder !== "undefined");
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      checkHealth();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    checkHealth();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Pregunta antes de cerrar la pestaña si hay trabajo sin terminar
  useEffect(() => {
    const need = isRecording || isProcessing || preparing || (!!audioBlob && !transcription);
    if (!need) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [isRecording, isProcessing, preparing, audioBlob, transcription]);

  // Batería baja mientras se graba
  useEffect(() => {
    if (!isRecording) {
      setBatteryLow(false);
      return;
    }
    let battery: any;
    const update = () => setBatteryLow(!!battery && battery.level <= 0.15 && !battery.charging);
    (navigator as any).getBattery?.().then((b: any) => {
      battery = b;
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    }).catch(() => {});
    return () => {
      if (battery) {
        battery.removeEventListener("levelchange", update);
        battery.removeEventListener("chargingchange", update);
      }
    };
  }, [isRecording]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (timerRef.current) clearInterval(timerRef.current);
      if (peakTimerRef.current) clearInterval(peakTimerRef.current);
      recognitionRef.current?.stop();
    };
  }, [audioUrl]);

  // ---------- PDFs ----------
  const extractPdfText = async (file: File) => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
      text += `\n[Página ${i}]\n${pageText}`;
    }
    return { text: text.trim(), pages: pdf.numPages };
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";

    const validPdfs = files.filter((f) => f.type === "application/pdf");
    if (validPdfs.length !== files.length) alert("Solo se permiten archivos PDF.");
    if (pdfDocs.length + validPdfs.length > 5) {
      alert("Máximo 5 archivos PDF permitidos.");
      return;
    }

    setReadingPdf(true);
    for (const file of validPdfs) {
      try {
        const { text, pages } = await extractPdfText(file);
        if (text.replace(/\[Página \d+\]/g, "").trim().length < 50) {
          alert(`"${file.name}" parece un PDF escaneado (sin texto). No se puede leer así.`);
          continue;
        }
        setPdfDocs((prev) => [...prev, { name: file.name, size: file.size, pages, text }]);
      } catch (err) {
        console.error(err);
        alert(`No se pudo leer "${file.name}".`);
      }
    }
    setReadingPdf(false);
  };

  const removePdf = (i: number) => setPdfDocs((prev) => prev.filter((_, idx) => idx !== i));

  // ---------- Preparar audio (decodificar, onda y partes) ----------
  const prepareAudio = async (blob: Blob, isUpload: boolean) => {
    setPreparing(true);
    setPrepareError("");
    setAudioReady(false);
    try {
      const { samples, rate } = await decodeToMono(blob);
      const duration = samples.length / rate;
      if (isUpload && duration > MAX_UPLOAD_SECONDS) {
        throw new Error(`Este audio dura ${fmt(duration)}. El máximo es 2 horas.`);
      }
      const peaks = computePeaks(samples, rate);
      samplesRef.current = { samples, rate };
      peaksRef.current = peaks;
      planRef.current = planChunks(peaks, duration);
      resultsRef.current = [];
      setAudioDuration(duration);
      setPeaksVersion((v) => v + 1);
      setProgress({ done: 0, total: planRef.current.length });
      setAudioReady(true);
    } catch (err) {
      console.error(err);
      setPrepareError(
        err instanceof Error && err.message.startsWith("Este audio")
          ? err.message
          : "No pude procesar este audio en tu dispositivo: el formato no es compatible o es demasiado pesado para la memoria. Prueba con mp3, m4a o wav, o desde un computador."
      );
    } finally {
      setPreparing(false);
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (audioInputRef.current) audioInputRef.current.value = "";
    if (!file) return;
    resetRecording();
    setAudioBlob(file);
    setAudioUrl(URL.createObjectURL(file));
    await prepareAudio(file, true);
  };

  // ---------- Grabación ----------
  const startRecording = async () => {
    if (health && !health.groq) {
      const ok = confirm(
        "El servicio de transcripción no responde en este momento. Puedes grabar igual y transcribir después, sin cerrar la pestaña. ¿Grabar de todos modos?"
      );
      if (!ok) return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      peaksRef.current = [];
      setPeaksVersion(0);
      setMarkers([]);
      setActiveId(null);
      setCurrentTime(0);
      setAudioDuration(0);
      setSegments([]);
      setTranscribeError("");
      setPrepareError("");
      setMicLost(false);

      // Si el micrófono se desconecta, se conserva lo grabado y se avisa
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        setMicLost(true);
        stopRecording();
      });

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      peakTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let dev = 0;
        for (let i = 0; i < buf.length; i++) dev = Math.max(dev, Math.abs(buf[i] - 128) / 128);
        peaksRef.current.push(Math.min(1, dev * 3));
        setPeaksVersion((v) => v + 1);
      }, 200);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setTranscription("");
        setTopicAnalysis("");
        stream.getTracks().forEach((t) => t.stop());
        if (peakTimerRef.current) clearInterval(peakTimerRef.current);
        audioCtxRef.current?.close();
        prepareAudio(blob, false);
      };

      mediaRecorder.start(10000);
      setIsRecording(true);
      setRecordingTime(0);
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setRecordingTime(elapsed);
        if (elapsed >= MAX_SECONDS) stopRecording();
      }, 1000);

      try {
        wakeRef.current = await (navigator as any).wakeLock?.request("screen");
      } catch {
       
      }
    } catch {
      alert("No se pudo acceder al micrófono. Concede los permisos necesarios.");
    }
  };

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    wakeRef.current?.release?.().catch?.(() => {});
    wakeRef.current = null;
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setTranscription("");
    setTranscribeError("");
    setPrepareError("");
    setAudioReady(false);
    setSegments([]);
    setMarkers([]);
    setMarkersError("");
    setActiveId(null);
    activeRef.current = null;
    queueRef.current = [];
    peaksRef.current = [];
    samplesRef.current = null;
    planRef.current = [];
    resultsRef.current = [];
    setProgress({ done: 0, total: 0 });
    setPeaksVersion((v) => v + 1);
    setAudioDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setTopicAnalysis("");
    setCustomPrompt("");
    setRecordingTime(0);
    setMicLost(false);
    setMode("answer");
  };

  // ---------- Reproducción y marcas ----------
  const onLoadedMetadata = () => {
    const a = audioRef.current;
    if (a && a.duration === Infinity) {
      a.currentTime = 1e101;
      const fix = () => {
        a.removeEventListener("timeupdate", fix);
        a.currentTime = 0;
      };
      a.addEventListener("timeupdate", fix);
    }
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const seekTo = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    queueRef.current = [];
    activeRef.current = null;
    setActiveId(null);
    a.currentTime = Math.max(0, t);
    setCurrentTime(a.currentTime);
  };

  const startMarker = (m: Marker) => {
    const a = audioRef.current;
    if (!a) return;
    activeRef.current = m;
    setActiveId(m.id);
    a.currentTime = m.start;
    a.play().catch(() => {});
  };

  const playMarker = (m: Marker) => {
    queueRef.current = [];
    startMarker(m);
  };

  const playAllMarkers = () => {
    if (markers.length === 0) return;
    queueRef.current = markers.slice(1);
    startMarker(markers[0]);
  };

  const stopPlayback = () => {
    queueRef.current = [];
    activeRef.current = null;
    setActiveId(null);
    audioRef.current?.pause();
  };

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setCurrentTime(a.currentTime);
    const m = activeRef.current;
    if (m && a.currentTime >= m.end) {
      const next = queueRef.current.shift();
      if (next) {
        startMarker(next);
      } else {
        activeRef.current = null;
        setActiveId(null);
        a.pause();
      }
    }
  };

  // ---------- Transcripción por partes ----------
  const waitWithStatus = async (seconds: number, label: string) => {
    for (let s = Math.ceil(seconds); s > 0; s--) {
      setProcessStatus(`${label} ${s}s...`);
      await sleep(1000);
    }
  };

  const transcribeChunk = async (idx: number): Promise<ChunkResult> => {
    const audio = samplesRef.current!;
    const [a, b] = planRef.current[idx];
    const from = Math.floor(a * audio.rate);
    const to = Math.min(Math.floor(b * audio.rate), audio.samples.length);
    const blob = wavBlob(audio.samples, audio.rate, from, to);

    let lastMsg = "El servicio de transcripción no responde.";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!navigator.onLine) {
        setProcessStatus("Sin internet. Esperando conexión...");
        while (!navigator.onLine) await sleep(1500);
      }

      let res: Response;
      try {
        const fd = new FormData();
        fd.append("file", blob, `parte-${idx + 1}.wav`);
        res = await fetch("/api/transcribe", { method: "POST", body: fd });
      } catch {
        lastMsg = "Se perdió la conexión con el servidor.";
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        return {
          text: data.text || "",
          segments: (data.segments || []).map((s: Segment) => ({
            start: s.start + a,
            end: s.end + a,
            text: s.text,
          })),
        };
      }

      if (res.status === 429) {
        lastMsg = "Se alcanzó el límite de uso de la transcripción.";
        await waitWithStatus(Math.min(60, (data.retryAfter || 15) + 1), "Límite de uso alcanzado. Reanudando en");
        continue;
      }
      if (res.status >= 500) {
        lastMsg = data.error || "El servicio de transcripción tuvo un problema.";
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 401) throw new Error("La clave de transcripción no es válida. Avisa al administrador.");
      throw new Error(data.error || `Error ${res.status}`);
    }
    throw new Error(lastMsg);
  };

  const transcribeAudio = async () => {
    if (!samplesRef.current) return;
    const plan = planRef.current;
    if (resultsRef.current.length !== plan.length) resultsRef.current = new Array(plan.length).fill(null);
    const results = resultsRef.current;

    setIsProcessing(true);
    setTranscribeError("");
    setTranscription("");
    setSegments([]);

    const pending = plan.map((_, i) => i).filter((i) => !results[i]);
    let done = plan.length - pending.length;
    let next = 0;
    let failure = "";
    setProgress({ done, total: plan.length });
    setProcessStatus(`Transcribiendo parte ${done + 1} de ${plan.length}`);

    const worker = async () => {
      while (!failure) {
        const idx = pending[next++];
        if (idx === undefined) return;
        try {
          results[idx] = await transcribeChunk(idx);
          done++;
          setProgress({ done, total: plan.length });
          setProcessStatus(`Transcribiendo parte ${Math.min(done + 1, plan.length)} de ${plan.length}`);
        } catch (err) {
          failure = err instanceof Error ? err.message : "Fallo al transcribir";
        }
      }
    };

    await Promise.all([worker(), worker()]);

    if (failure || results.some((r) => !r)) {
      setTranscribeError(
        `${failure || "Faltaron partes."} Llevas ${done} de ${plan.length} partes. Pulsa "Continuar" para seguir desde ahí.`
      );
    } else {
      const all = results as ChunkResult[];
      setTranscription(all.map((r) => r.text.trim()).filter(Boolean).join(" ") || "No se detectó voz.");
      setSegments(all.flatMap((r) => r.segments));
    }

    setProcessStatus("");
    setIsProcessing(false);
  };

  // ---------- Marcas con IA ----------
  const findMarkers = async (auto: boolean) => {
    if (segments.length === 0) return;
    if (!auto && !customPrompt.trim()) return;

    stopPlayback();
    setMarkersLoading(true);
    setMarkersError("");
    setMarkers([]);

    try {
      const response = await fetch("/api/markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: auto ? "" : customPrompt.trim(),
          segments,
          duration: audioDuration,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Error al generar marcas");
      setMarkers(data.markers || []);
      if ((data.markers || []).length === 0) setMarkersError("No encontré momentos de la clase que respondan eso.");
    } catch (err) {
      setMarkersError(err instanceof Error ? err.message : "Fallo de conexión.");
    } finally {
      setMarkersLoading(false);
    }
  };

  // ---------- Respuesta con streaming ----------
  const analyzeWithAI = async () => {
    if (!transcription && pdfDocs.length === 0) return;
    if (!customPrompt.trim()) return;

    setIsProcessing(true);
    setProcessStatus("Pensando...");
    setTopicAnalysis("");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: customPrompt.trim(),
          transcription,
          documents: pdfDocs.map((d) => ({ name: d.name, text: d.text })),
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Error al analizar");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let first = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first) {
          setIsProcessing(false);
          setProcessStatus("");
          first = false;
        }
        setTopicAnalysis((prev) => prev + decoder.decode(value, { stream: true }));
      }

      if (first) setTopicAnalysis("La IA devolvió una respuesta vacía. Intenta de nuevo.");
    } catch (err) {
      console.error(err);
      setTopicAnalysis(`❌ ${err instanceof Error ? err.message : "Fallo de conexión."}`);
    } finally {
      setProcessStatus("");
      setIsProcessing(false);
    }
  };

  // ---------- Dictado: navegador y, si falla, grabación + Groq ----------
  const startRecordDictation = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      dictRecRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (dictTimeoutRef.current) clearTimeout(dictTimeoutRef.current);
        const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1000) {
          setDictState("idle");
          return;
        }
        setDictState("busy");
        try {
          const fd = new FormData();
          fd.append("file", blob, "pregunta.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Error al transcribir");
          const text = String(data.text || "").trim();
          if (text) setCustomPrompt((p) => (p.trim() ? p.trim() + " " : "") + text);
        } catch (err) {
          alert(err instanceof Error ? err.message : "No se pudo transcribir tu voz.");
        } finally {
          setDictState("idle");
        }
      };

      rec.start();
      setDictState("rec");
      dictTimeoutRef.current = setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, 60000);
    } catch {
      setDictState("idle");
      alert("Permite el acceso al micrófono para dictar.");
    }
  };

  const startLiveDictation = (SR: any) => {
    const rec = new SR();
    rec.lang = "es-CO";
    rec.interimResults = true;
    rec.continuous = true;
    const base = customPrompt.trim() ? customPrompt.trim() + " " : "";
    liveStartRef.current = Date.now();
    liveGotResultRef.current = false;
    liveStoppedByUserRef.current = false;

    rec.onresult = (e: any) => {
      liveGotResultRef.current = true;
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setCustomPrompt((base + finalText + interim).trimStart());
    };

    const fallback = () => {
      dictFallbackRef.current = true; // este navegador no tiene dictado nativo (ej. Brave)
      setDictState("idle");
      startRecordDictation();
    };

    rec.onerror = (e: any) => {
      if (["network", "service-not-allowed", "language-not-supported"].includes(e.error)) {
        fallback();
      } else if (e.error === "not-allowed") {
        setDictState("idle");
        alert("Permite el acceso al micrófono para dictar.");
      }
    };
    rec.onend = () => {
      setDictState((s) => {
        if (s !== "live") return s;
        // Terminó casi al instante y sin texto: el navegador no soporta el servicio
        if (!liveStoppedByUserRef.current && !liveGotResultRef.current && Date.now() - liveStartRef.current < 2500) {
          fallback();
          return "idle";
        }
        return "idle";
      });
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setDictState("live");
    } catch {
      fallback();
    }
  };

  const toggleDictation = () => {
    if (dictState === "busy") return;
    if (dictState === "live") {
      liveStoppedByUserRef.current = true;
      recognitionRef.current?.stop();
      return;
    }
    if (dictState === "rec") {
      if (dictRecRef.current && dictRecRef.current.state !== "inactive") dictRecRef.current.stop();
      return;
    }

    audioRef.current?.pause();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR && !dictFallbackRef.current) startLiveDictation(SR);
    else startRecordDictation();
  };

  // ---------- Enviar según el modo ----------
  const hasSegments = segments.length > 0;
  const canSubmit =
    !isProcessing &&
    !markersLoading &&
    (mode === "topics"
      ? hasSegments
      : mode === "markers"
      ? hasSegments && customPrompt.trim().length > 0
      : customPrompt.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    if (dictState === "live") {
      liveStoppedByUserRef.current = true;
      recognitionRef.current?.stop();
    }
    if (mode === "answer") analyzeWithAI();
    else if (mode === "markers") findMarkers(false);
    else findMarkers(true);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const placeholder =
    dictState === "live"
      ? "Escuchando... habla ahora"
      : dictState === "rec"
      ? "Grabando tu pregunta... toca el micrófono al terminar"
      : dictState === "busy"
      ? "Transcribiendo tu voz..."
      : mode === "answer"
      ? "Pregunta lo que quieras sobre la clase"
      : "¿Qué momento buscas? Ej: cuando habló de cadencias";

  const showAsk = (transcription || pdfDocs.length > 0) && !isRecording;

  const modes: { id: Mode; label: string; needsSegments: boolean }[] = [
    { id: "answer", label: "Preguntar", needsSegments: false },
    { id: "markers", label: "Marcar", needsSegments: true },
    { id: "topics", label: "Temas", needsSegments: true },
  ];

  // ---------- Alertas ----------
  const notices: Notice[] = [];
  if (!online)
    notices.push({
      level: "error",
      text: "Sin conexión a internet. Puedes seguir grabando, pero transcribir y preguntar necesitan conexión.",
    });
  if (micLost)
    notices.push({
      level: "error",
      text: "El micrófono se desconectó. La grabación se detuvo y se conservó lo grabado hasta ahí.",
    });
  if (isRecording)
    notices.push({ level: "info", text: "No cierres ni recargues esta pestaña mientras grabas." });
  if (isRecording && MAX_SECONDS - recordingTime <= WARN_REMAINING)
    notices.push({
      level: "warn",
      text: `Quedan ${Math.max(1, Math.ceil((MAX_SECONDS - recordingTime) / 60))} min del máximo de 2 horas. La grabación se detendrá sola.`,
    });
  if (isRecording && batteryLow)
    notices.push({ level: "warn", text: "Batería baja. Conecta el cargador para no perder la clase." });
  if (online && health && !health.groq)
    notices.push({
      level: "warn",
      text: "La transcripción no responde ahora (servicio caído o clave inválida). Puedes grabar y transcribir más tarde sin cerrar la pestaña.",
    });
  if (online && health && !health.gemini)
    notices.push({ level: "warn", text: "La IA de preguntas no responde ahora. Las respuestas pueden fallar." });

  const noticeStyle: Record<Notice["level"], string> = {
    error: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
    warn: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    info: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  };

  return (
    <div className="flex min-h-screen justify-center bg-white px-5 py-10 font-sans text-zinc-900 dark:bg-black dark:text-zinc-100">
      <main className="w-full max-w-xl space-y-8">
        <h1 className="text-center text-xl font-semibold tracking-tight">Transcriptor + IA</h1>

        {notices.length > 0 && (
          <div className="space-y-2" role="status">
            {notices.map((n, i) => (
              <p key={i} className={`rounded-xl px-4 py-2.5 text-sm ${noticeStyle[n.level]}`}>
                {n.text}
              </p>
            ))}
          </div>
        )}

        
        <section>
          {isRecording && (
            <div className="space-y-5">
              <Waveform
                peaks={peaksRef.current}
                version={peaksVersion}
                duration={0}
                currentTime={0}
                markers={[]}
                activeId={null}
                live
              />
              <div className="flex flex-col items-center gap-3">
                <span className="font-mono text-2xl tabular-nums">{fmt(recordingTime)}</span>
                <button
                  onClick={stopRecording}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                  aria-label="Detener grabación"
                >
                  <StopIcon />
                </button>
              </div>
            </div>
          )}

          {!isRecording && !audioUrl && (
            <div className="flex flex-col items-center gap-3 py-6">
              <button
                onClick={startRecording}
                className="flex h-20 w-20 items-center justify-center rounded-full bg-red-600 text-white shadow-lg shadow-red-600/20 transition hover:scale-105 hover:bg-red-700"
                aria-label="Grabar clase"
              >
                <MicIcon size={30} />
              </button>
              <p className="text-sm text-zinc-500">Grabar clase</p>
              <button
                onClick={() => audioInputRef.current?.click()}
                className="text-sm text-zinc-500 underline-offset-2 hover:underline"
              >
                o sube un audio
              </button>
              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={handleAudioUpload}
              />
            </div>
          )}

          {!isRecording && audioUrl && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={togglePlay}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700"
                  aria-label={isPlaying ? "Pausar" : "Reproducir"}
                >
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <div className="min-w-0 flex-1">
                  <Waveform
                    peaks={peaksRef.current}
                    version={peaksVersion}
                    duration={audioDuration}
                    currentTime={currentTime}
                    markers={markers}
                    activeId={activeId}
                    onSeek={seekTo}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-mono text-xs tabular-nums text-zinc-500">
                  {fmt(currentTime)} / {fmt(audioDuration)}
                </span>
                <button onClick={resetRecording} className="text-xs text-zinc-500 underline-offset-2 hover:underline">
                  Descartar y empezar de nuevo
                </button>
              </div>

              <audio
                ref={audioRef}
                src={audioUrl}
                hidden
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />

              {preparing && (
                <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                  <Spinner />
                  <span>Preparando audio...</span>
                </div>
              )}
              {prepareError && <p className="text-center text-sm text-red-600 dark:text-red-400">{prepareError}</p>}

              {audioReady && !transcription && !isProcessing && (
                <button
                  onClick={transcribeAudio}
                  className="w-full rounded-full bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-violet-700"
                >
                  {progress.done > 0 ? "Continuar transcripción" : "Transcribir clase"}
                </button>
              )}
              {transcribeError && <p className="text-center text-sm text-red-600 dark:text-red-400">{transcribeError}</p>}
            </div>
          )}
        </section>

        
        {isProcessing && (
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <Spinner />
              <span>{processStatus}</span>
            </div>
            {progress.total > 1 && (
              <div className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full bg-violet-600 transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        
        {showAsk && (
          <section className="space-y-4">
            <div className="mx-auto flex w-fit rounded-full bg-zinc-100 p-1 dark:bg-zinc-900">
              {modes.map((m) => {
                const disabled = m.needsSegments && !hasSegments;
                const active = mode === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => !disabled && setMode(m.id)}
                    disabled={disabled}
                    title={disabled ? "Necesita una clase transcrita desde el audio" : undefined}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                      active
                        ? "bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300"
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>

            {mode !== "topics" ? (
              <div
                className={`flex items-end gap-2 rounded-2xl border bg-white p-2 transition dark:bg-zinc-950 ${
                  dictState === "live" || dictState === "rec"
                    ? "border-red-400 ring-2 ring-red-400/20"
                    : "border-zinc-300 focus-within:border-violet-500 dark:border-zinc-700"
                }`}
              >
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={placeholder}
                  rows={2}
                  className="min-h-[3rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-400"
                />
                {canDictate && (
                  <button
                    onClick={toggleDictation}
                    disabled={dictState === "busy"}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
                      dictState === "live" || dictState === "rec"
                        ? "animate-pulse bg-red-600 text-white"
                        : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    } ${dictState === "busy" ? "opacity-50" : ""}`}
                    aria-label="Dictar pregunta"
                    title="Dictar pregunta"
                  >
                    {dictState === "busy" ? <Spinner /> : <MicIcon />}
                  </button>
                )}
                <button
                  onClick={submit}
                  disabled={!canSubmit}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Enviar"
                >
                  <SendIcon />
                </button>
              </div>
            ) : (
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="w-full rounded-full bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Detectar los temas de la clase
              </button>
            )}
          </section>
        )}

       
        {showAsk && mode === "answer" && topicAnalysis && (
          <section className="space-y-3 rounded-2xl bg-zinc-50 p-5 dark:bg-zinc-900">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{topicAnalysis}</p>
            <div className="flex gap-4">
              <button onClick={() => copyToClipboard(topicAnalysis)} className="text-xs text-zinc-500 hover:underline">
                Copiar
              </button>
              <button onClick={() => setTopicAnalysis("")} className="text-xs text-zinc-500 hover:underline">
                Limpiar
              </button>
            </div>
          </section>
        )}

        {showAsk && mode !== "answer" && (markersLoading || markers.length > 0 || markersError) && (
          <section className="space-y-3">
            {markersLoading && (
              <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <Spinner />
                <span>Buscando momentos...</span>
              </div>
            )}
            {markersError && <p className="text-center text-sm text-red-600 dark:text-red-400">{markersError}</p>}

            {markers.length > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">{markers.length} momentos</span>
                  <div className="flex gap-4">
                    <button onClick={playAllMarkers} className="text-xs font-medium text-violet-700 hover:underline dark:text-violet-300">
                      Reproducir todos
                    </button>
                    <button onClick={stopPlayback} className="text-xs text-zinc-500 hover:underline">
                      Parar
                    </button>
                  </div>
                </div>

                <ul className="space-y-2">
                  {markers.map((m) => {
                    const active = m.id === activeId;
                    return (
                      <li key={m.id}>
                        <button
                          onClick={() => (active ? stopPlayback() : playMarker(m))}
                          className={`flex w-full items-start gap-3 rounded-xl p-3 text-left transition ${
                            active
                              ? "bg-violet-50 ring-1 ring-violet-400 dark:bg-violet-950/40"
                              : "bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                          }`}
                        >
                          <span
                            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                              active ? "bg-violet-600 text-white" : "bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300"
                            }`}
                          >
                            {active ? <PauseIcon /> : <PlayIcon />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">{m.title}</span>
                            <span className="block font-mono text-xs text-zinc-500">
                              {fmt(m.start)} – {fmt(m.end)}
                            </span>
                            {m.summary && <span className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400">{m.summary}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        )}

       
        <section className="space-y-2 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          {transcription && (
            <details className="group">
              <summary className="cursor-pointer list-none text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                Ver transcripción
              </summary>
              <div className="mt-3 space-y-2">
                <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {transcription}
                </p>
                <button onClick={() => copyToClipboard(transcription)} className="text-xs text-zinc-500 hover:underline">
                  Copiar
                </button>
              </div>
            </details>
          )}

          <details className="group">
            <summary className="cursor-pointer list-none text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              Documentos de apoyo {pdfDocs.length > 0 && `(${pdfDocs.length})`}
            </summary>
            <div className="mt-3 space-y-3">
              <input
                type="file"
                accept="application/pdf"
                multiple
                ref={fileInputRef}
                onChange={handleFileChange}
                disabled={readingPdf}
                className="block w-full cursor-pointer text-sm text-zinc-500 file:mr-3 file:rounded-full file:border-0 file:bg-zinc-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200 disabled:opacity-50 dark:file:bg-zinc-800 dark:file:text-zinc-200"
              />
              <p className="text-xs text-zinc-400">Hasta 5 PDFs con texto. Se leen en tu navegador.</p>
              {readingPdf && (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Spinner />
                  <span>Leyendo PDF...</span>
                </div>
              )}
              {pdfDocs.length > 0 && (
                <ul className="space-y-1.5">
                  {pdfDocs.map((doc, index) => (
                    <li key={index} className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-900">
                      <span className="truncate text-zinc-700 dark:text-zinc-300">
                        {doc.name} <span className="text-xs text-zinc-400">· {doc.pages} pág.</span>
                      </span>
                      <button onClick={() => removePdf(index)} className="ml-2 text-zinc-400 hover:text-red-500" aria-label="Quitar">
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </section>
      </main>
    </div>
  );
}*/

/*"use client";

import { useState, useRef, useEffect } from "react";

type PdfDoc = { name: string; size: number; pages: number; text: string };
type Segment = { start: number; end: number; text: string };
type Marker = { id: number; start: number; end: number; title: string; summary: string };
type Mode = "answer" | "markers" | "topics";
type Notice = { level: "error" | "warn" | "info"; text: string };
type ChunkResult = { text: string; segments: Segment[] };
type DictState = "idle" | "live" | "rec" | "busy";

const MAX_SECONDS = 7200; // 2 horas de grabación
const MAX_UPLOAD_SECONDS = 7500; // tolerancia al subir archivos
const WARN_REMAINING = 20 * 60;
const CHUNK_SECONDS = 120; // 120 s de WAV 16 kHz mono ≈ 3.8 MB, bajo el límite de 4.5 MB
const PEAK_STEP = 0.2;

const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = m.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Procesamiento de audio en el navegador ----------
async function decodeToMono(blob: Blob): Promise<{ samples: Int16Array; rate: number }> {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length;
    const chans = audio.numberOfChannels;
    const data: Float32Array[] = [];
    for (let c = 0; c < chans; c++) data.push(audio.getChannelData(c));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += data[c][i];
      s /= chans;
      s = Math.max(-1, Math.min(1, s));
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return { samples: out, rate: audio.sampleRate };
  } finally {
    ctx.close();
  }
}

function computePeaks(samples: Int16Array, rate: number): number[] {
  const w = Math.max(1, Math.floor(rate * PEAK_STEP));
  const n = Math.ceil(samples.length / w);
  const peaks = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    let m = 0;
    const end = Math.min(samples.length, (k + 1) * w);
    for (let j = k * w; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > m) m = a;
    }
    peaks[k] = Math.min(1, (m / 32768) * 3);
  }
  return peaks;
}

// Corta cada ~120 s, buscando el punto más silencioso para no partir palabras
function planChunks(peaks: number[], duration: number): [number, number][] {
  const plan: [number, number][] = [];
  let start = 0;
  while (duration - start > CHUNK_SECONDS) {
    const target = start + CHUNK_SECONDS;
    const fromIdx = Math.floor((target - 10) / PEAK_STEP);
    const toIdx = Math.floor(target / PEAK_STEP);
    let bestIdx = toIdx;
    let bestVal = Infinity;
    for (let i = fromIdx; i <= toIdx; i++) {
      const v = peaks[i] ?? 0;
      if (v < bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    const cut = Math.min(target, bestIdx * PEAK_STEP);
    plan.push([start, cut]);
    start = cut;
  }
  plan.push([start, duration]);
  return plan;
}

function wavBlob(samples: Int16Array, rate: number, from: number, to: number): Blob {
  const slice = samples.subarray(from, to);
  const len = slice.length * 2;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + len, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len, true);
  new Int16Array(buf, 44).set(slice);
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- Iconos ----------
const PlayIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
);
const StopIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
);
const MicIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </svg>
);
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 16V4M6 10l6-6 6 6M5 20h14" />
  </svg>
);
const ChevronIcon = () => (
  <svg className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
const Spinner = ({ className = "" }: { className?: string }) => (
  <div className={`h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-violet-600 border-t-transparent ${className}`} />
);

// ---------- Onda de audio ----------
function Waveform({
  peaks,
  version,
  duration,
  currentTime,
  markers,
  activeId,
  onSeek,
  live = false,
  height = 56,
}: {
  peaks: number[];
  version: number;
  duration: number;
  currentTime: number;
  markers: Marker[];
  activeId: number | null;
  onSeek?: (t: number) => void;
  live?: boolean;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const total = duration > 0 ? duration : peaks.length * PEAK_STEP || 1;

  // Redibuja cuando cambia el ancho (giro de pantalla, redimensionar)
  useEffect(() => {
    const c = ref.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = height;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const idle = dark ? "#52525b" : "#d4d4d8";

    if (live) {
      const n = Math.floor(w / 4);
      const slice = peaks.slice(-n);
      ctx.fillStyle = "#ef4444";
      slice.forEach((p, i) => {
        const bh = Math.max(3, p * h * 0.95);
        const x = w - (slice.length - i) * 4;
        ctx.beginPath();
        ctx.roundRect(x, (h - bh) / 2, 2.5, bh, 1.25);
        ctx.fill();
      });
      return;
    }

    markers.forEach((m) => {
      ctx.fillStyle = m.id === activeId ? "rgba(124,58,237,0.28)" : "rgba(124,58,237,0.12)";
      ctx.beginPath();
      ctx.roundRect((m.start / total) * w, 0, Math.max(((m.end - m.start) / total) * w, 3), h, 4);
      ctx.fill();
    });

    const bars = Math.max(1, Math.floor(w / 4));
    const playedX = (currentTime / total) * w;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i / bars) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let max = 0;
      for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j];
      const bh = Math.max(3, max * h * 0.92);
      const x = i * 4;
      ctx.fillStyle = x < playedX ? "#7c3aed" : idle;
      ctx.beginPath();
      ctx.roundRect(x, (h - bh) / 2, 2.5, bh, 1.25);
      ctx.fill();
    }

    if (currentTime > 0) {
      ctx.fillStyle = "#7c3aed";
      ctx.fillRect(playedX, 0, 2, h);
    }
  }, [peaks, version, total, currentTime, markers, activeId, height, live, width]);

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height }}
      className={`block touch-manipulation ${onSeek ? "cursor-pointer" : ""}`}
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * total);
      }}
    />
  );
}

// ---------- Estilos reutilizables ----------
const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-black";
const primaryBtn = `inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-violet-600 px-5 text-sm font-semibold text-white transition hover:bg-violet-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;
const linkBtn = `rounded-md py-1 text-xs text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-100 ${focusRing}`;

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);

  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [audioReady, setAudioReady] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [transcribeError, setTranscribeError] = useState("");

  const [transcription, setTranscription] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [topicAnalysis, setTopicAnalysis] = useState("");
  const [mode, setMode] = useState<Mode>("answer");
  const [copied, setCopied] = useState("");

  const [pdfDocs, setPdfDocs] = useState<PdfDoc[]>([]);
  const [readingPdf, setReadingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Onda, reproducción y marcas
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [markersLoading, setMarkersLoading] = useState(false);
  const [markersError, setMarkersError] = useState("");

  // Alertas
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState<{ groq: boolean; gemini: boolean } | null>(null);
  const [micLost, setMicLost] = useState(false);
  const [batteryLow, setBatteryLow] = useState(false);

  // Dictado
  const [dictState, setDictState] = useState<DictState>("idle");
  const [canDictate, setCanDictate] = useState(false);
  const recognitionRef = useRef<any>(null);
  const dictFallbackRef = useRef(false);
  const dictRecRef = useRef<MediaRecorder | null>(null);
  const dictTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveStartRef = useRef(0);
  const liveGotResultRef = useRef(false);
  const liveStoppedByUserRef = useRef(false);

  const peaksRef = useRef<number[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<Marker[]>([]);
  const activeRef = useRef<Marker | null>(null);

  const samplesRef = useRef<{ samples: Int16Array; rate: number } | null>(null);
  const planRef = useRef<[number, number][]>([]);
  const resultsRef = useRef<(ChunkResult | null)[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peakTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef(0);
  const wakeRef = useRef<any>(null);

  // ---------- Estado de red y salud de servicios ----------
  const checkHealth = async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  };

  useEffect(() => {
    setCanDictate(typeof MediaRecorder !== "undefined");
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      checkHealth();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    checkHealth();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Pregunta antes de cerrar la pestaña si hay trabajo sin terminar
  useEffect(() => {
    const need = isRecording || isProcessing || preparing || (!!audioBlob && !transcription);
    if (!need) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [isRecording, isProcessing, preparing, audioBlob, transcription]);

  // Batería baja mientras se graba
  useEffect(() => {
    if (!isRecording) {
      setBatteryLow(false);
      return;
    }
    let battery: any;
    const update = () => setBatteryLow(!!battery && battery.level <= 0.15 && !battery.charging);
    (navigator as any).getBattery?.().then((b: any) => {
      battery = b;
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    }).catch(() => {});
    return () => {
      if (battery) {
        battery.removeEventListener("levelchange", update);
        battery.removeEventListener("chargingchange", update);
      }
    };
  }, [isRecording]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (timerRef.current) clearInterval(timerRef.current);
      if (peakTimerRef.current) clearInterval(peakTimerRef.current);
      recognitionRef.current?.stop();
    };
  }, [audioUrl]);

  // El cuadro de texto crece con el contenido (hasta un máximo)
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [customPrompt, mode]);

  // ---------- PDFs ----------
  const extractPdfText = async (file: File) => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
      text += `\n[Página ${i}]\n${pageText}`;
    }
    return { text: text.trim(), pages: pdf.numPages };
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";

    const validPdfs = files.filter((f) => f.type === "application/pdf");
    if (validPdfs.length !== files.length) alert("Solo se permiten archivos PDF.");
    if (pdfDocs.length + validPdfs.length > 5) {
      alert("Máximo 5 archivos PDF permitidos.");
      return;
    }

    setReadingPdf(true);
    for (const file of validPdfs) {
      try {
        const { text, pages } = await extractPdfText(file);
        if (text.replace(/\[Página \d+\]/g, "").trim().length < 50) {
          alert(`"${file.name}" parece un PDF escaneado (sin texto). No se puede leer así.`);
          continue;
        }
        setPdfDocs((prev) => [...prev, { name: file.name, size: file.size, pages, text }]);
      } catch (err) {
        console.error(err);
        alert(`No se pudo leer "${file.name}".`);
      }
    }
    setReadingPdf(false);
  };

  const removePdf = (i: number) => setPdfDocs((prev) => prev.filter((_, idx) => idx !== i));

  // ---------- Preparar audio (decodificar, onda y partes) ----------
  const prepareAudio = async (blob: Blob, isUpload: boolean) => {
    setPreparing(true);
    setPrepareError("");
    setAudioReady(false);
    try {
      const { samples, rate } = await decodeToMono(blob);
      const duration = samples.length / rate;
      if (isUpload && duration > MAX_UPLOAD_SECONDS) {
        throw new Error(`Este audio dura ${fmt(duration)}. El máximo es 2 horas.`);
      }
      const peaks = computePeaks(samples, rate);
      samplesRef.current = { samples, rate };
      peaksRef.current = peaks;
      planRef.current = planChunks(peaks, duration);
      resultsRef.current = [];
      setAudioDuration(duration);
      setPeaksVersion((v) => v + 1);
      setProgress({ done: 0, total: planRef.current.length });
      setAudioReady(true);
    } catch (err) {
      console.error(err);
      setPrepareError(
        err instanceof Error && err.message.startsWith("Este audio")
          ? err.message
          : "No pude procesar este audio en tu dispositivo: el formato no es compatible o es demasiado pesado para la memoria. Prueba con mp3, m4a o wav, o desde un computador."
      );
    } finally {
      setPreparing(false);
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (audioInputRef.current) audioInputRef.current.value = "";
    if (!file) return;
    resetRecording();
    setAudioBlob(file);
    setAudioUrl(URL.createObjectURL(file));
    await prepareAudio(file, true);
  };

  // ---------- Grabación ----------
  const startRecording = async () => {
    if (health && !health.groq) {
      const ok = confirm(
        "El servicio de transcripción no responde en este momento. Puedes grabar igual y transcribir después, sin cerrar la pestaña. ¿Grabar de todos modos?"
      );
      if (!ok) return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      peaksRef.current = [];
      setPeaksVersion(0);
      setMarkers([]);
      setActiveId(null);
      setCurrentTime(0);
      setAudioDuration(0);
      setSegments([]);
      setTranscribeError("");
      setPrepareError("");
      setMicLost(false);

      // Si el micrófono se desconecta, se conserva lo grabado y se avisa
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        setMicLost(true);
        stopRecording();
      });

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      peakTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let dev = 0;
        for (let i = 0; i < buf.length; i++) dev = Math.max(dev, Math.abs(buf[i] - 128) / 128);
        peaksRef.current.push(Math.min(1, dev * 3));
        setPeaksVersion((v) => v + 1);
      }, 200);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setTranscription("");
        setTopicAnalysis("");
        stream.getTracks().forEach((t) => t.stop());
        if (peakTimerRef.current) clearInterval(peakTimerRef.current);
        audioCtxRef.current?.close();
        prepareAudio(blob, false);
      };

      mediaRecorder.start(10000);
      setIsRecording(true);
      setRecordingTime(0);
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setRecordingTime(elapsed);
        if (elapsed >= MAX_SECONDS) stopRecording();
      }, 1000);

      try {
        wakeRef.current = await (navigator as any).wakeLock?.request("screen");
      } catch {
        
      }
    } catch {
      alert("No se pudo acceder al micrófono. Concede los permisos necesarios.");
    }
  };

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    wakeRef.current?.release?.().catch?.(() => {});
    wakeRef.current = null;
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setTranscription("");
    setTranscribeError("");
    setPrepareError("");
    setAudioReady(false);
    setSegments([]);
    setMarkers([]);
    setMarkersError("");
    setActiveId(null);
    activeRef.current = null;
    queueRef.current = [];
    peaksRef.current = [];
    samplesRef.current = null;
    planRef.current = [];
    resultsRef.current = [];
    setProgress({ done: 0, total: 0 });
    setPeaksVersion((v) => v + 1);
    setAudioDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setTopicAnalysis("");
    setCustomPrompt("");
    setRecordingTime(0);
    setMicLost(false);
    setMode("answer");
  };

  // ---------- Reproducción y marcas ----------
  const onLoadedMetadata = () => {
    const a = audioRef.current;
    if (a && a.duration === Infinity) {
      a.currentTime = 1e101;
      const fix = () => {
        a.removeEventListener("timeupdate", fix);
        a.currentTime = 0;
      };
      a.addEventListener("timeupdate", fix);
    }
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const seekTo = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    queueRef.current = [];
    activeRef.current = null;
    setActiveId(null);
    a.currentTime = Math.max(0, t);
    setCurrentTime(a.currentTime);
  };

  const startMarker = (m: Marker) => {
    const a = audioRef.current;
    if (!a) return;
    activeRef.current = m;
    setActiveId(m.id);
    a.currentTime = m.start;
    a.play().catch(() => {});
  };

  const playMarker = (m: Marker) => {
    queueRef.current = [];
    startMarker(m);
  };

  const playAllMarkers = () => {
    if (markers.length === 0) return;
    queueRef.current = markers.slice(1);
    startMarker(markers[0]);
  };

  const stopPlayback = () => {
    queueRef.current = [];
    activeRef.current = null;
    setActiveId(null);
    audioRef.current?.pause();
  };

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setCurrentTime(a.currentTime);
    const m = activeRef.current;
    if (m && a.currentTime >= m.end) {
      const next = queueRef.current.shift();
      if (next) {
        startMarker(next);
      } else {
        activeRef.current = null;
        setActiveId(null);
        a.pause();
      }
    }
  };

  // ---------- Transcripción por partes ----------
  const waitWithStatus = async (seconds: number, label: string) => {
    for (let s = Math.ceil(seconds); s > 0; s--) {
      setProcessStatus(`${label} ${s}s...`);
      await sleep(1000);
    }
  };

  const transcribeChunk = async (idx: number): Promise<ChunkResult> => {
    const audio = samplesRef.current!;
    const [a, b] = planRef.current[idx];
    const from = Math.floor(a * audio.rate);
    const to = Math.min(Math.floor(b * audio.rate), audio.samples.length);
    const blob = wavBlob(audio.samples, audio.rate, from, to);

    let lastMsg = "El servicio de transcripción no responde.";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!navigator.onLine) {
        setProcessStatus("Sin internet. Esperando conexión...");
        while (!navigator.onLine) await sleep(1500);
      }

      let res: Response;
      try {
        const fd = new FormData();
        fd.append("file", blob, `parte-${idx + 1}.wav`);
        res = await fetch("/api/transcribe", { method: "POST", body: fd });
      } catch {
        lastMsg = "Se perdió la conexión con el servidor.";
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        return {
          text: data.text || "",
          segments: (data.segments || []).map((s: Segment) => ({
            start: s.start + a,
            end: s.end + a,
            text: s.text,
          })),
        };
      }

      if (res.status === 429) {
        lastMsg = "Se alcanzó el límite de uso de la transcripción.";
        await waitWithStatus(Math.min(60, (data.retryAfter || 15) + 1), "Límite de uso alcanzado. Reanudando en");
        continue;
      }
      if (res.status >= 500) {
        lastMsg = data.error || "El servicio de transcripción tuvo un problema.";
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 401) throw new Error("La clave de transcripción no es válida. Avisa al administrador.");
      throw new Error(data.error || `Error ${res.status}`);
    }
    throw new Error(lastMsg);
  };

  const transcribeAudio = async () => {
    if (!samplesRef.current) return;
    const plan = planRef.current;
    if (resultsRef.current.length !== plan.length) resultsRef.current = new Array(plan.length).fill(null);
    const results = resultsRef.current;

    setIsProcessing(true);
    setTranscribeError("");
    setTranscription("");
    setSegments([]);

    const pending = plan.map((_, i) => i).filter((i) => !results[i]);
    let done = plan.length - pending.length;
    let next = 0;
    let failure = "";
    setProgress({ done, total: plan.length });
    setProcessStatus(`Transcribiendo parte ${done + 1} de ${plan.length}`);

    const worker = async () => {
      while (!failure) {
        const idx = pending[next++];
        if (idx === undefined) return;
        try {
          results[idx] = await transcribeChunk(idx);
          done++;
          setProgress({ done, total: plan.length });
          setProcessStatus(`Transcribiendo parte ${Math.min(done + 1, plan.length)} de ${plan.length}`);
        } catch (err) {
          failure = err instanceof Error ? err.message : "Fallo al transcribir";
        }
      }
    };

    await Promise.all([worker(), worker()]);

    if (failure || results.some((r) => !r)) {
      setTranscribeError(
        `${failure || "Faltaron partes."} Llevas ${done} de ${plan.length} partes. Pulsa "Continuar" para seguir desde ahí.`
      );
    } else {
      const all = results as ChunkResult[];
      setTranscription(all.map((r) => r.text.trim()).filter(Boolean).join(" ") || "No se detectó voz.");
      setSegments(all.flatMap((r) => r.segments));
    }

    setProcessStatus("");
    setIsProcessing(false);
  };

  // ---------- Marcas con IA ----------
  const findMarkers = async (auto: boolean) => {
    if (segments.length === 0) return;
    if (!auto && !customPrompt.trim()) return;

    stopPlayback();
    setMarkersLoading(true);
    setMarkersError("");
    setMarkers([]);

    try {
      const response = await fetch("/api/markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: auto ? "" : customPrompt.trim(),
          segments,
          duration: audioDuration,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Error al generar marcas");
      setMarkers(data.markers || []);
      if ((data.markers || []).length === 0) setMarkersError("No encontré momentos de la clase que respondan eso.");
    } catch (err) {
      setMarkersError(err instanceof Error ? err.message : "Fallo de conexión.");
    } finally {
      setMarkersLoading(false);
    }
  };

  // ---------- Respuesta con streaming ----------
  const analyzeWithAI = async () => {
    if (!transcription && pdfDocs.length === 0) return;
    if (!customPrompt.trim()) return;

    setIsProcessing(true);
    setProcessStatus("Pensando...");
    setTopicAnalysis("");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: customPrompt.trim(),
          transcription,
          documents: pdfDocs.map((d) => ({ name: d.name, text: d.text })),
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Error al analizar");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let first = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first) {
          setIsProcessing(false);
          setProcessStatus("");
          first = false;
        }
        setTopicAnalysis((prev) => prev + decoder.decode(value, { stream: true }));
      }

      if (first) setTopicAnalysis("La IA devolvió una respuesta vacía. Intenta de nuevo.");
    } catch (err) {
      console.error(err);
      setTopicAnalysis(`❌ ${err instanceof Error ? err.message : "Fallo de conexión."}`);
    } finally {
      setProcessStatus("");
      setIsProcessing(false);
    }
  };

  // ---------- Dictado: navegador y, si falla, grabación + Groq ----------
  const startRecordDictation = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      dictRecRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (dictTimeoutRef.current) clearTimeout(dictTimeoutRef.current);
        const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1000) {
          setDictState("idle");
          return;
        }
        setDictState("busy");
        try {
          const fd = new FormData();
          fd.append("file", blob, "pregunta.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Error al transcribir");
          const text = String(data.text || "").trim();
          if (text) setCustomPrompt((p) => (p.trim() ? p.trim() + " " : "") + text);
        } catch (err) {
          alert(err instanceof Error ? err.message : "No se pudo transcribir tu voz.");
        } finally {
          setDictState("idle");
        }
      };

      rec.start();
      setDictState("rec");
      dictTimeoutRef.current = setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, 60000);
    } catch {
      setDictState("idle");
      alert("Permite el acceso al micrófono para dictar.");
    }
  };

  const startLiveDictation = (SR: any) => {
    const rec = new SR();
    rec.lang = "es-CO";
    rec.interimResults = true;
    rec.continuous = true;
    const base = customPrompt.trim() ? customPrompt.trim() + " " : "";
    liveStartRef.current = Date.now();
    liveGotResultRef.current = false;
    liveStoppedByUserRef.current = false;

    rec.onresult = (e: any) => {
      liveGotResultRef.current = true;
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setCustomPrompt((base + finalText + interim).trimStart());
    };

    const fallback = () => {
      dictFallbackRef.current = true; // este navegador no tiene dictado nativo (ej. Brave)
      setDictState("idle");
      startRecordDictation();
    };

    rec.onerror = (e: any) => {
      if (["network", "service-not-allowed", "language-not-supported"].includes(e.error)) {
        fallback();
      } else if (e.error === "not-allowed") {
        setDictState("idle");
        alert("Permite el acceso al micrófono para dictar.");
      }
    };
    rec.onend = () => {
      setDictState((s) => {
        if (s !== "live") return s;
        // Terminó casi al instante y sin texto: el navegador no soporta el servicio
        if (!liveStoppedByUserRef.current && !liveGotResultRef.current && Date.now() - liveStartRef.current < 2500) {
          fallback();
          return "idle";
        }
        return "idle";
      });
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setDictState("live");
    } catch {
      fallback();
    }
  };

  const toggleDictation = () => {
    if (dictState === "busy") return;
    if (dictState === "live") {
      liveStoppedByUserRef.current = true;
      recognitionRef.current?.stop();
      return;
    }
    if (dictState === "rec") {
      if (dictRecRef.current && dictRecRef.current.state !== "inactive") dictRecRef.current.stop();
      return;
    }

    audioRef.current?.pause();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR && !dictFallbackRef.current) startLiveDictation(SR);
    else startRecordDictation();
  };

  // ---------- Enviar según el modo ----------
  const hasSegments = segments.length > 0;
  const canSubmit =
    !isProcessing &&
    !markersLoading &&
    (mode === "topics"
      ? hasSegments
      : mode === "markers"
      ? hasSegments && customPrompt.trim().length > 0
      : customPrompt.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    if (dictState === "live") {
      liveStoppedByUserRef.current = true;
      recognitionRef.current?.stop();
    }
    if (mode === "answer") analyzeWithAI();
    else if (mode === "markers") findMarkers(false);
    else findMarkers(true);
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1500);
  };

  const placeholder =
    dictState === "live"
      ? "Escuchando... habla ahora"
      : dictState === "rec"
      ? "Grabando tu pregunta... toca el micrófono al terminar"
      : dictState === "busy"
      ? "Transcribiendo tu voz..."
      : mode === "answer"
      ? "Pregunta lo que quieras sobre la clase"
      : "¿Qué momento buscas? Ej: cuando habló de cadencias";

  const suggestions =
    mode === "answer"
      ? ["Resume la clase", "¿Cuáles son las ideas clave?", "¿Qué tareas dejaron?"]
      : ["Cuando explicó un ejemplo", "Cuando dejaron tarea", "Cuando hicieron preguntas"];

  const showAsk = (transcription || pdfDocs.length > 0) && !isRecording;

  const modes: { id: Mode; label: string; needsSegments: boolean }[] = [
    { id: "answer", label: "Preguntar", needsSegments: false },
    { id: "markers", label: "Marcar", needsSegments: true },
    { id: "topics", label: "Temas", needsSegments: true },
  ];

  // ---------- Alertas ----------
  const notices: Notice[] = [];
  if (!online)
    notices.push({
      level: "error",
      text: "Sin conexión. Puedes seguir grabando, pero transcribir y preguntar necesitan internet.",
    });
  if (micLost)
    notices.push({
      level: "error",
      text: "El micrófono se desconectó. La grabación se detuvo y se conservó lo grabado hasta ahí.",
    });
  if (isRecording)
    notices.push({ level: "info", text: "No cierres ni recargues esta pestaña mientras grabas." });
  if (isRecording && MAX_SECONDS - recordingTime <= WARN_REMAINING)
    notices.push({
      level: "warn",
      text: `Quedan ${Math.max(1, Math.ceil((MAX_SECONDS - recordingTime) / 60))} min del máximo de 2 horas. La grabación se detendrá sola.`,
    });
  if (isRecording && batteryLow)
    notices.push({ level: "warn", text: "Batería baja. Conecta el cargador para no perder la clase." });
  if (online && health && !health.groq)
    notices.push({
      level: "warn",
      text: "La transcripción no responde ahora. Puedes grabar y transcribir más tarde sin cerrar la pestaña.",
    });
  if (online && health && !health.gemini)
    notices.push({ level: "warn", text: "La IA de preguntas no responde ahora. Las respuestas pueden fallar." });

  const noticeStyle: Record<Notice["level"], { box: string; dot: string }> = {
    error: { box: "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200", dot: "bg-red-500" },
    warn: { box: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200", dot: "bg-amber-500" },
    info: { box: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400", dot: "bg-zinc-400" },
  };

  const dictActive = dictState === "live" || dictState === "rec";
  const resultsVisible = showAsk && mode !== "answer" && (markersLoading || markers.length > 0 || markersError);

  return (
    <div className="min-h-dvh bg-white font-sans text-zinc-900 antialiased dark:bg-black dark:text-zinc-100">
      <main className="mx-auto w-full max-w-xl space-y-8 px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:space-y-10 sm:px-6 sm:pt-12">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">Transcriptor + IA</h1>
          {isRecording && (
            <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              Grabando
            </span>
          )}
        </header>

        {notices.length > 0 && (
          <div className="space-y-2" role="status" aria-live="polite">
            {notices.map((n, i) => (
              <p key={i} className={`flex items-start gap-2.5 rounded-2xl px-4 py-3 text-[13px] leading-snug ${noticeStyle[n.level].box}`}>
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${noticeStyle[n.level].dot}`} />
                <span>{n.text}</span>
              </p>
            ))}
          </div>
        )}

        
        <section aria-label="Audio">
          {isRecording && (
            <div className="space-y-6 rounded-3xl bg-zinc-50 p-5 dark:bg-zinc-900/60 sm:p-6">
              <Waveform
                peaks={peaksRef.current}
                version={peaksVersion}
                duration={0}
                currentTime={0}
                markers={[]}
                activeId={null}
                live
                height={72}
              />
              <div className="flex flex-col items-center gap-4">
                <span className="font-mono text-4xl font-light tabular-nums tracking-tight">{fmt(recordingTime)}</span>
                <button
                  onClick={stopRecording}
                  className={`flex h-16 w-16 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 ${focusRing}`}
                  aria-label="Detener grabación"
                >
                  <StopIcon />
                </button>
              </div>
            </div>
          )}

          {!isRecording && !audioUrl && (
            <div className="flex flex-col items-center gap-5 py-10 sm:py-14">
              <div className="relative">
                <span className="absolute inset-0 animate-ping rounded-full bg-red-500/20 motion-reduce:hidden" style={{ animationDuration: "2.8s" }} />
                <button
                  onClick={startRecording}
                  className={`relative flex h-24 w-24 items-center justify-center rounded-full bg-red-600 text-white shadow-xl shadow-red-600/25 transition hover:scale-105 hover:bg-red-700 active:scale-95 ${focusRing}`}
                  aria-label="Grabar clase"
                >
                  <MicIcon size={34} />
                </button>
              </div>
              <div className="space-y-1 text-center">
                <p className="text-base font-medium">Grabar clase</p>
                <p className="text-sm text-zinc-500">Hasta 2 horas de audio</p>
              </div>
              <button
                onClick={() => audioInputRef.current?.click()}
                className={`inline-flex h-11 items-center gap-2 rounded-full border border-zinc-200 px-5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 ${focusRing}`}
              >
                <UploadIcon />
                Subir un audio
              </button>
              <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={handleAudioUpload} />
            </div>
          )}

          {!isRecording && audioUrl && (
            <div className="space-y-5">
              <div className="rounded-3xl bg-zinc-50 p-4 dark:bg-zinc-900/60 sm:p-5">
                <div className="flex items-center gap-3 sm:gap-4">
                  <button
                    onClick={togglePlay}
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700 active:scale-95 ${focusRing}`}
                    aria-label={isPlaying ? "Pausar" : "Reproducir"}
                  >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <Waveform
                      peaks={peaksRef.current}
                      version={peaksVersion}
                      duration={audioDuration}
                      currentTime={currentTime}
                      markers={markers}
                      activeId={activeId}
                      onSeek={seekTo}
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-xs tabular-nums text-zinc-500">
                    {fmt(currentTime)} / {fmt(audioDuration)}
                  </span>
                  <button onClick={resetRecording} className={linkBtn}>
                    Empezar de nuevo
                  </button>
                </div>
              </div>

              <audio
                ref={audioRef}
                src={audioUrl}
                hidden
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />

              {preparing && (
                <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                  <Spinner />
                  <span>Preparando audio...</span>
                </div>
              )}
              {prepareError && <p className="text-center text-sm leading-snug text-red-600 dark:text-red-400">{prepareError}</p>}

              {audioReady && !transcription && !isProcessing && (
                <button onClick={transcribeAudio} className={primaryBtn}>
                  {progress.done > 0 ? "Continuar transcripción" : "Transcribir clase"}
                </button>
              )}
              {transcribeError && <p className="text-center text-sm leading-snug text-red-600 dark:text-red-400">{transcribeError}</p>}
            </div>
          )}
        </section>

        
        {isProcessing && (
          <div className="space-y-3" role="status" aria-live="polite">
            <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <Spinner />
              <span>{processStatus}</span>
            </div>
            {progress.total > 1 && (
              <div className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-violet-600 transition-all duration-500"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

       
        {showAsk && (
          <section className="space-y-4" aria-label="Herramientas de la clase">
            <div className="grid grid-cols-3 rounded-full bg-zinc-100 p-1 dark:bg-zinc-900" role="tablist">
              {modes.map((m) => {
                const disabled = m.needsSegments && !hasSegments;
                const active = mode === m.id;
                return (
                  <button
                    key={m.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => !disabled && setMode(m.id)}
                    disabled={disabled}
                    title={disabled ? "Necesita una clase transcrita desde el audio" : undefined}
                    className={`h-10 rounded-full text-sm font-medium transition ${focusRing} ${
                      active
                        ? "bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300"
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>

            {mode !== "topics" ? (
              <>
                <div
                  className={`flex items-end gap-1.5 rounded-3xl border bg-white p-2 transition dark:bg-zinc-950 ${
                    dictActive
                      ? "border-red-400 ring-4 ring-red-400/10"
                      : "border-zinc-200 focus-within:border-violet-500 focus-within:ring-4 focus-within:ring-violet-500/10 dark:border-zinc-800"
                  }`}
                >
                  <textarea
                    ref={promptRef}
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    placeholder={placeholder}
                    rows={1}
                    aria-label={mode === "answer" ? "Tu pregunta" : "Momento que buscas"}
                    className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent px-3 py-3 text-base leading-snug outline-none placeholder:text-zinc-400 sm:text-[15px]"
                  />
                  {canDictate && (
                    <button
                      onClick={toggleDictation}
                      disabled={dictState === "busy"}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition ${focusRing} ${
                        dictActive
                          ? "animate-pulse bg-red-600 text-white"
                          : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      } ${dictState === "busy" ? "opacity-60" : ""}`}
                      aria-label={dictActive ? "Detener dictado" : "Dictar pregunta"}
                      title="Dictar"
                    >
                      {dictState === "busy" ? <Spinner /> : <MicIcon />}
                    </button>
                  )}
                  <button
                    onClick={submit}
                    disabled={!canSubmit}
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
                    aria-label="Enviar"
                  >
                    <SendIcon />
                  </button>
                </div>

                {!customPrompt.trim() && !topicAnalysis && !resultsVisible && (mode === "answer" || hasSegments) && (
                  <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setCustomPrompt(s);
                          promptRef.current?.focus();
                        }}
                        className={`h-9 shrink-0 rounded-full border border-zinc-200 px-4 text-[13px] text-zinc-600 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-violet-800 dark:hover:bg-violet-950/40 dark:hover:text-violet-300 ${focusRing}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <button onClick={submit} disabled={!canSubmit} className={primaryBtn}>
                Detectar los temas de la clase
              </button>
            )}
          </section>
        )}

        
        {showAsk && mode === "answer" && topicAnalysis && (
          <section className="space-y-4 rounded-3xl bg-zinc-50 p-5 dark:bg-zinc-900/60 sm:p-6">
            <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed sm:leading-7">{topicAnalysis}</p>
            <div className="flex gap-5">
              <button onClick={() => copyToClipboard(topicAnalysis, "answer")} className={linkBtn}>
                {copied === "answer" ? "Copiado ✓" : "Copiar"}
              </button>
              <button onClick={() => setTopicAnalysis("")} className={linkBtn}>
                Limpiar
              </button>
            </div>
          </section>
        )}

        {resultsVisible && (
          <section className="space-y-3" aria-live="polite">
            {markersLoading && (
              <div className="flex items-center justify-center gap-2 py-2 text-sm text-zinc-600 dark:text-zinc-400">
                <Spinner />
                <span>Buscando momentos...</span>
              </div>
            )}
            {markersError && <p className="text-center text-sm text-red-600 dark:text-red-400">{markersError}</p>}

            {markers.length > 0 && (
              <>
                <div className="flex items-center justify-between px-1">
                  <span className="text-sm text-zinc-500">
                    {markers.length} {markers.length === 1 ? "momento" : "momentos"}
                  </span>
                  <div className="flex gap-4">
                    <button onClick={playAllMarkers} className={`${linkBtn} font-medium !text-violet-700 dark:!text-violet-300`}>
                      Reproducir todos
                    </button>
                    <button onClick={stopPlayback} className={linkBtn}>
                      Parar
                    </button>
                  </div>
                </div>

                <ul className="space-y-2">
                  {markers.map((m) => {
                    const active = m.id === activeId;
                    return (
                      <li key={m.id}>
                        <button
                          onClick={() => (active ? stopPlayback() : playMarker(m))}
                          aria-pressed={active}
                          className={`flex w-full items-start gap-3 rounded-2xl p-3.5 text-left transition ${focusRing} ${
                            active
                              ? "bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-950/40 dark:ring-violet-800"
                              : "bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/60 dark:hover:bg-zinc-900"
                          }`}
                        >
                          <span
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
                              active ? "bg-violet-600 text-white" : "bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300"
                            }`}
                          >
                            {active ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-3">
                              <span className="text-sm font-medium leading-snug">{m.title}</span>
                              <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-500">{fmt(m.start)}</span>
                            </span>
                            {m.summary && <span className="mt-1 block text-[13px] leading-snug text-zinc-600 dark:text-zinc-400">{m.summary}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        )}

        
        <section className="divide-y divide-zinc-200 border-t border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {transcription && (
            <details className="group py-1">
              <summary className="flex min-h-[3rem] cursor-pointer list-none items-center justify-between text-sm text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                <span>Ver transcripción</span>
                <ChevronIcon />
              </summary>
              <div className="space-y-3 pb-4">
                <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {transcription}
                </p>
                <button onClick={() => copyToClipboard(transcription, "tr")} className={linkBtn}>
                  {copied === "tr" ? "Copiado ✓" : "Copiar"}
                </button>
              </div>
            </details>
          )}

          <details className="group py-1">
            <summary className="flex min-h-[3rem] cursor-pointer list-none items-center justify-between text-sm text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
              <span>
                Documentos de apoyo
                {pdfDocs.length > 0 && (
                  <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                    {pdfDocs.length}
                  </span>
                )}
              </span>
              <ChevronIcon />
            </summary>
            <div className="space-y-3 pb-4">
              <input
                type="file"
                accept="application/pdf"
                multiple
                ref={fileInputRef}
                onChange={handleFileChange}
                disabled={readingPdf}
                hidden
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={readingPdf || pdfDocs.length >= 5}
                className={`flex w-full flex-col items-center gap-1 rounded-2xl border border-dashed border-zinc-300 px-4 py-5 text-sm text-zinc-600 transition hover:border-violet-400 hover:bg-violet-50/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-violet-700 dark:hover:bg-violet-950/20 ${focusRing}`}
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <UploadIcon />
                  Añadir PDF
                </span>
                <span className="text-xs text-zinc-400">Hasta 5 con texto. Se leen en tu navegador.</span>
              </button>
              {readingPdf && (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Spinner />
                  <span>Leyendo PDF...</span>
                </div>
              )}
              {pdfDocs.length > 0 && (
                <ul className="space-y-1.5">
                  {pdfDocs.map((doc, index) => (
                    <li key={index} className="flex items-center justify-between gap-2 rounded-xl bg-zinc-50 py-1 pl-3 pr-1 text-sm dark:bg-zinc-900/60">
                      <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">
                        {doc.name} <span className="text-xs text-zinc-400">· {doc.pages} pág.</span>
                      </span>
                      <button
                        onClick={() => removePdf(index)}
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:text-red-500 ${focusRing}`}
                        aria-label={`Quitar ${doc.name}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </section>
      </main>
    </div>
  );
}*/


"use client";

import { useState, useRef, useEffect } from "react";

type PdfDoc = { name: string; size: number; pages: number; text: string };
type Segment = { start: number; end: number; text: string };
type Marker = { id: number; start: number; end: number; title: string; summary: string };
type Mode = "answer" | "markers" | "topics" | "quiz";
type Notice = { level: "error" | "warn" | "info"; text: string };
type ChunkResult = { text: string; segments: Segment[] };
type DictState = "idle" | "live" | "rec" | "busy";
type QuizQ = { question: string; options: string[]; correct: number; explanation: string; ref: string; at: number | null };
type SavedSession = { id: string; title: string; createdAt: string; duration: number; hasTranscript: boolean };
type SaveStatus = "idle" | "saving" | "saved" | "error";

const MAX_SECONDS = 7200;
const MAX_UPLOAD_SECONDS = 7500;
const WARN_REMAINING = 20 * 60;
const CHUNK_SECONDS = 120;
const PEAK_STEP = 0.2;
const LETTERS = ["A", "B", "C", "D"];

const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = m.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Procesamiento de audio en el navegador ----------
async function decodeToMono(blob: Blob): Promise<{ samples: Int16Array; rate: number }> {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length;
    const chans = audio.numberOfChannels;
    const data: Float32Array[] = [];
    for (let c = 0; c < chans; c++) data.push(audio.getChannelData(c));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += data[c][i];
      s /= chans;
      s = Math.max(-1, Math.min(1, s));
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return { samples: out, rate: audio.sampleRate };
  } finally {
    ctx.close();
  }
}

function computePeaks(samples: Int16Array, rate: number): number[] {
  const w = Math.max(1, Math.floor(rate * PEAK_STEP));
  const n = Math.ceil(samples.length / w);
  const peaks = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    let m = 0;
    const end = Math.min(samples.length, (k + 1) * w);
    for (let j = k * w; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > m) m = a;
    }
    peaks[k] = Math.min(1, (m / 32768) * 3);
  }
  return peaks;
}

function planChunks(peaks: number[], duration: number): [number, number][] {
  const plan: [number, number][] = [];
  let start = 0;
  while (duration - start > CHUNK_SECONDS) {
    const target = start + CHUNK_SECONDS;
    const fromIdx = Math.floor((target - 10) / PEAK_STEP);
    const toIdx = Math.floor(target / PEAK_STEP);
    let bestIdx = toIdx;
    let bestVal = Infinity;
    for (let i = fromIdx; i <= toIdx; i++) {
      const v = peaks[i] ?? 0;
      if (v < bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    const cut = Math.min(target, bestIdx * PEAK_STEP);
    plan.push([start, cut]);
    start = cut;
  }
  plan.push([start, duration]);
  return plan;
}

function wavBlob(samples: Int16Array, rate: number, from: number, to: number): Blob {
  const slice = samples.subarray(from, to);
  const len = slice.length * 2;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + len, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len, true);
  new Int16Array(buf, 44).set(slice);
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- Iconos ----------
const PlayIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
);
const StopIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
);
const MicIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </svg>
);
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 16V4M6 10l6-6 6 6M5 20h14" />
  </svg>
);
const ChevronIcon = () => (
  <svg className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
const Spinner = ({ className = "" }: { className?: string }) => (
  <div className={`h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-violet-600 border-t-transparent ${className}`} />
);
const SunIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="5" />
    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
  </svg>
);
const MoonIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const SpeakerIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);
const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12l5 5L20 7" />
  </svg>
);
const CrossIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// ---------- Onda de audio ----------
function Waveform({
  peaks,
  version,
  duration,
  currentTime,
  markers,
  activeId,
  onSeek,
  dark,
  live = false,
  height = 56,
}: {
  peaks: number[];
  version: number;
  duration: number;
  currentTime: number;
  markers: Marker[];
  activeId: number | null;
  onSeek?: (t: number) => void;
  dark: boolean;
  live?: boolean;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const total = duration > 0 ? duration : peaks.length * PEAK_STEP || 1;

  useEffect(() => {
    const c = ref.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = height;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const idle = dark ? "#52525b" : "#d4d4d8";

    if (live) {
      const n = Math.floor(w / 4);
      const slice = peaks.slice(-n);
      ctx.fillStyle = "#ef4444";
      slice.forEach((p, i) => {
        const bh = Math.max(3, p * h * 0.95);
        const x = w - (slice.length - i) * 4;
        ctx.beginPath();
        ctx.roundRect(x, (h - bh) / 2, 2.5, bh, 1.25);
        ctx.fill();
      });
      return;
    }

    markers.forEach((m) => {
      ctx.fillStyle = m.id === activeId ? "rgba(124,58,237,0.28)" : "rgba(124,58,237,0.12)";
      ctx.beginPath();
      ctx.roundRect((m.start / total) * w, 0, Math.max(((m.end - m.start) / total) * w, 3), h, 4);
      ctx.fill();
    });

    const bars = Math.max(1, Math.floor(w / 4));
    const playedX = (currentTime / total) * w;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i / bars) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let max = 0;
      for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j];
      const bh = Math.max(3, max * h * 0.92);
      const x = i * 4;
      ctx.fillStyle = x < playedX ? "#7c3aed" : idle;
      ctx.beginPath();
      ctx.roundRect(x, (h - bh) / 2, 2.5, bh, 1.25);
      ctx.fill();
    }

    if (currentTime > 0) {
      ctx.fillStyle = "#7c3aed";
      ctx.fillRect(playedX, 0, 2, h);
    }
  }, [peaks, version, total, currentTime, markers, activeId, height, live, width, dark]);

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height }}
      className={`block touch-manipulation ${onSeek ? "cursor-pointer" : ""}`}
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * total);
      }}
    />
  );
}

// ---------- Estilos reutilizables ----------
const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-black";
const primaryBtn = `inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-violet-600 px-5 text-sm font-semibold text-white transition hover:bg-violet-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;
const linkBtn = `rounded-md py-1 text-xs text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-100 ${focusRing}`;

export default function Home() {
  // ---------- Tema claro / oscuro ----------
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    let dark = false;
    try {
      const saved = localStorage.getItem("theme");
      dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      /* sin almacenamiento */
    }
    setIsDarkMode(dark);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.classList.toggle("dark", isDarkMode);
    try {
      localStorage.setItem("theme", isDarkMode ? "dark" : "light");
    } catch {
      /* sin almacenamiento */
    }
  }, [isDarkMode, themeReady]);

  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);

  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [audioReady, setAudioReady] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [transcribeError, setTranscribeError] = useState("");

  const [transcription, setTranscription] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [topicAnalysis, setTopicAnalysis] = useState("");
  const [mode, setMode] = useState<Mode>("answer");
  const [copied, setCopied] = useState("");

  // ---------- Nube (Backblaze) ----------
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("");
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [openingId, setOpeningId] = useState("");
  const sessionIdRef = useRef("");
  const audioKeyRef = useRef("");
  const audioTypeRef = useRef("");
  const titleRef = useRef("");
  const createdAtRef = useRef("");
  const durationRef = useRef(0);
  const transcriptRef = useRef<{ text: string; segments: Segment[] }>({ text: "", segments: [] });
  const pendingRef = useRef<{ blob: Blob } | null>(null);

  const [isSpeaking, setIsSpeaking] = useState(false);

  const [pdfDocs, setPdfDocs] = useState<PdfDoc[]>([]);
  const [readingPdf, setReadingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const [peaksVersion, setPeaksVersion] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [markersLoading, setMarkersLoading] = useState(false);
  const [markersError, setMarkersError] = useState("");
  const markersReqRef = useRef(0);

  // Quiz
  const [quiz, setQuiz] = useState<QuizQ[]>([]);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [quizCount, setQuizCount] = useState(5);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizError, setQuizError] = useState("");
  const quizReqRef = useRef(0);

  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState<{ groq: boolean; gemini: boolean } | null>(null);
  const [micLost, setMicLost] = useState(false);
  const [batteryLow, setBatteryLow] = useState(false);

  const [dictState, setDictState] = useState<DictState>("idle");
  const [canDictate, setCanDictate] = useState(false);
  const recognitionRef = useRef<any>(null);
  const dictFallbackRef = useRef(false);
  const dictRecRef = useRef<MediaRecorder | null>(null);
  const dictTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveStartRef = useRef(0);
  const liveGotResultRef = useRef(false);
  const liveStoppedByUserRef = useRef(false);

  const peaksRef = useRef<number[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<Marker[]>([]);
  const activeRef = useRef<Marker | null>(null);

  const samplesRef = useRef<{ samples: Int16Array; rate: number } | null>(null);
  const planRef = useRef<[number, number][]>([]);
  const resultsRef = useRef<(ChunkResult | null)[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peakTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef(0);
  const wakeRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  const checkHealth = async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  };

  useEffect(() => {
    setCanDictate(typeof MediaRecorder !== "undefined");
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      checkHealth();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    checkHealth();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    const need =
      isRecording ||
      isProcessing ||
      preparing ||
      saveStatus === "saving" ||
      (!!audioBlob && !transcription && saveStatus !== "saved");
    if (!need) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [isRecording, isProcessing, preparing, audioBlob, transcription, saveStatus]);

  useEffect(() => {
    if (!isRecording) {
      setBatteryLow(false);
      return;
    }
    let battery: any;
    const update = () => setBatteryLow(!!battery && battery.level <= 0.15 && !battery.charging);
    (navigator as any).getBattery?.().then((b: any) => {
      battery = b;
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    }).catch(() => {});
    return () => {
      if (battery) {
        battery.removeEventListener("levelchange", update);
        battery.removeEventListener("chargingchange", update);
      }
    };
  }, [isRecording]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (timerRef.current) clearInterval(timerRef.current);
      if (peakTimerRef.current) clearInterval(peakTimerRef.current);
      recognitionRef.current?.stop();
    };
  }, [audioUrl]);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [customPrompt, mode]);

  // ---------- PDFs ----------
  const extractPdfText = async (file: File) => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
      text += `\n[Página ${i}]\n${pageText}`;
    }
    return { text: text.trim(), pages: pdf.numPages };
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";

    const validPdfs = files.filter((f) => f.type === "application/pdf");
    if (validPdfs.length !== files.length) alert("Solo se permiten archivos PDF.");
    if (pdfDocs.length + validPdfs.length > 5) {
      alert("Máximo 5 archivos PDF permitidos.");
      return;
    }

    setReadingPdf(true);
    for (const file of validPdfs) {
      try {
        const { text, pages } = await extractPdfText(file);
        if (text.replace(/\[Página \d+\]/g, "").trim().length < 50) {
          alert(`"${file.name}" parece un PDF escaneado (sin texto). No se puede leer así.`);
          continue;
        }
        setPdfDocs((prev) => [...prev, { name: file.name, size: file.size, pages, text }]);
      } catch (err) {
        console.error(err);
        alert(`No se pudo leer "${file.name}".`);
      }
    }
    setReadingPdf(false);
  };

  const removePdf = (i: number) => setPdfDocs((prev) => prev.filter((_, idx) => idx !== i));

  // ---------- Guardado en la nube ----------
  const refreshSessions = async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const r = await fetch("/api/storage/sessions", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "No pude cargar tus clases guardadas.");
      setSessions(d.sessions || []);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : "No pude cargar tus clases guardadas.");
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    refreshSessions();
  }, []);

  // Escribe la clase en la nube con lo que haya hasta ahora (audio y, si existe, transcripción)
  const saveSession = async (): Promise<boolean> => {
    if (!sessionIdRef.current || !audioKeyRef.current) return false;
    const res = await fetch("/api/storage/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sessionIdRef.current,
        title: titleRef.current,
        createdAt: createdAtRef.current,
        audioKey: audioKeyRef.current,
        audioType: audioTypeRef.current,
        duration: durationRef.current,
        peaks: peaksRef.current.map((p) => Math.round(p * 100)),
        transcription: transcriptRef.current.text,
        segments: transcriptRef.current.segments,
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "No se pudo guardar la clase.");
    }
    return true;
  };

  const uploadAudio = async (blob: Blob, duration: number) => {
    setSaveStatus("saving");
    setSaveError("");
    pendingRef.current = { blob };
    durationRef.current = duration;

    const id = sessionIdRef.current || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionIdRef.current = id;

    try {
      const type = blob.type || "application/octet-stream";
      const ext = type.includes("webm")
        ? "webm"
        : type.includes("mp4") || type.includes("m4a")
        ? "m4a"
        : type.includes("mpeg") || type.includes("mp3")
        ? "mp3"
        : type.includes("wav")
        ? "wav"
        : type.includes("ogg")
        ? "ogg"
        : "bin";

      if (!createdAtRef.current) {
        const now = new Date();
        createdAtRef.current = now.toISOString();
        titleRef.current = "Clase del " + now.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
      }

      const r = await fetch("/api/storage/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, contentType: type, ext }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "No se pudo preparar el guardado.");

      const put = await fetch(d.url, { method: "PUT", headers: { "Content-Type": type }, body: blob });
      if (!put.ok) throw new Error("La nube rechazó el audio. Revisa la clave y el bucket.");

      if (sessionIdRef.current !== id) return; // el usuario descartó esta clase mientras subía
      audioKeyRef.current = d.key;
      audioTypeRef.current = type;
      await saveSession();
      if (sessionIdRef.current !== id) return;

      pendingRef.current = null;
      setSaveStatus("saved");
      refreshSessions();
    } catch (err) {
      console.error(err);
      if (sessionIdRef.current !== id) return;
      setSaveStatus("error");
      setSaveError(
        err instanceof TypeError
          ? "No pude conectar con la nube. Revisa las reglas CORS del bucket y tu conexión."
          : err instanceof Error
          ? err.message
          : "No se pudo guardar la clase."
      );
    }
  };

  const retrySave = async () => {
    if (pendingRef.current) {
      uploadAudio(pendingRef.current.blob, durationRef.current);
      return;
    }
    setSaveStatus("saving");
    setSaveError("");
    try {
      await saveSession();
      setSaveStatus("saved");
      refreshSessions();
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "No se pudo guardar la clase.");
    }
  };

  const openSession = async (id: string) => {
    if (openingId) return;
    resetRecording();
    setOpeningId(id);
    try {
      const r = await fetch(`/api/storage/session?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "No pude abrir esta clase.");

      sessionIdRef.current = id;
      audioKeyRef.current = d.audioKey;
      audioTypeRef.current = d.audioType || "";
      titleRef.current = d.title || "";
      createdAtRef.current = d.createdAt || "";
      durationRef.current = d.duration || 0;
      transcriptRef.current = { text: d.transcription || "", segments: d.segments || [] };

      peaksRef.current = (d.peaks || []).map((p: number) => p / 100);
      setAudioDuration(d.duration || 0);
      setPeaksVersion((v) => v + 1);
      setAudioUrl(d.audioUrl);
      setSaveStatus("saved");

      if (d.transcription) {
        setTranscription(d.transcription);
        setSegments(d.segments || []);
      } else {
        // Clase guardada sin transcribir: se descarga el audio para poder transcribirla
        const blob = await (await fetch(d.audioUrl)).blob();
        setAudioBlob(blob);
        await prepareAudio(blob, false, false);
      }
    } catch (err) {
      resetRecording();
      alert(err instanceof Error ? err.message : "No pude abrir esta clase.");
    } finally {
      setOpeningId("");
    }
  };

  const deleteSession = async (id: string) => {
    if (!confirm("¿Borrar esta clase y su audio de la nube? No se puede deshacer.")) return;
    try {
      const r = await fetch(`/api/storage/session?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      alert("No se pudo borrar la clase.");
    }
  };

  // ---------- Preparar audio ----------
  const prepareAudio = async (blob: Blob, isUpload: boolean, persist = true) => {
    setPreparing(true);
    setPrepareError("");
    setAudioReady(false);
    try {
      const { samples, rate } = await decodeToMono(blob);
      const duration = samples.length / rate;
      if (isUpload && duration > MAX_UPLOAD_SECONDS) {
        throw new Error(`Este audio dura ${fmt(duration)}. El máximo es 2 horas.`);
      }
      const peaks = computePeaks(samples, rate);
      samplesRef.current = { samples, rate };
      peaksRef.current = peaks;
      planRef.current = planChunks(peaks, duration);
      resultsRef.current = [];
      setAudioDuration(duration);
      setPeaksVersion((v) => v + 1);
      setProgress({ done: 0, total: planRef.current.length });
      setAudioReady(true);
      if (persist) uploadAudio(blob, duration);
    } catch (err) {
      console.error(err);
      setPrepareError(
        err instanceof Error && err.message.startsWith("Este audio")
          ? err.message
          : "No pude procesar este audio en tu dispositivo: el formato no es compatible o es demasiado pesado para la memoria. Prueba con mp3, m4a o wav, o desde un computador."
      );
    } finally {
      setPreparing(false);
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (audioInputRef.current) audioInputRef.current.value = "";
    if (!file) return;
    resetRecording();
    setAudioBlob(file);
    setAudioUrl(URL.createObjectURL(file));
    await prepareAudio(file, true);
  };

  // ---------- Grabación ----------
  const startRecording = async () => {
    if (health && !health.groq) {
      const ok = confirm(
        "El servicio de transcripción no responde en este momento. Puedes grabar igual y transcribir después, sin cerrar la pestaña. ¿Grabar de todos modos?"
      );
      if (!ok) return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      peaksRef.current = [];
      setPeaksVersion(0);
      setMarkers([]);
      setActiveId(null);
      setCurrentTime(0);
      setAudioDuration(0);
      setSegments([]);
      setTranscribeError("");
      setPrepareError("");
      setMicLost(false);

      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        setMicLost(true);
        stopRecording();
      });

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      peakTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let dev = 0;
        for (let i = 0; i < buf.length; i++) dev = Math.max(dev, Math.abs(buf[i] - 128) / 128);
        peaksRef.current.push(Math.min(1, dev * 3));
        setPeaksVersion((v) => v + 1);
      }, 200);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setTranscription("");
        setTopicAnalysis("");
        stream.getTracks().forEach((t) => t.stop());
        if (peakTimerRef.current) clearInterval(peakTimerRef.current);
        audioCtxRef.current?.close();
        prepareAudio(blob, false);
      };

      mediaRecorder.start(10000);
      setIsRecording(true);
      setRecordingTime(0);
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setRecordingTime(elapsed);
        if (elapsed >= MAX_SECONDS) stopRecording();
      }, 1000);

      try {
        wakeRef.current = await (navigator as any).wakeLock?.request("screen");
      } catch {
        /* no disponible */
      }
    } catch {
      alert("No se pudo acceder al micrófono. Concede los permisos necesarios.");
    }
  };

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    wakeRef.current?.release?.().catch?.(() => {});
    wakeRef.current = null;
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    markersReqRef.current++;
    quizReqRef.current++;
    setAudioBlob(null);
    setAudioUrl(null);
    setTranscription("");
    setTranscribeError("");
    setPrepareError("");
    setAudioReady(false);
    setSegments([]);
    setMarkers([]);
    setMarkersError("");
    setMarkersLoading(false);
    setQuiz([]);
    setAnswers([]);
    setQIndex(0);
    setQuizError("");
    setQuizLoading(false);
    setActiveId(null);
    activeRef.current = null;
    queueRef.current = [];
    peaksRef.current = [];
    samplesRef.current = null;
    planRef.current = [];
    resultsRef.current = [];
    setProgress({ done: 0, total: 0 });
    setPeaksVersion((v) => v + 1);
    setAudioDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setTopicAnalysis("");
    setCustomPrompt("");
    setRecordingTime(0);
    setMicLost(false);
    setMode("answer");
    sessionIdRef.current = "";
    audioKeyRef.current = "";
    audioTypeRef.current = "";
    titleRef.current = "";
    createdAtRef.current = "";
    durationRef.current = 0;
    transcriptRef.current = { text: "", segments: [] };
    pendingRef.current = null;
    setSaveStatus("idle");
    setSaveError("");
  };

  // ---------- Reproducción y marcas ----------
  const onLoadedMetadata = () => {
    const a = audioRef.current;
    if (a && a.duration === Infinity) {
      a.currentTime = 1e101;
      const fix = () => {
        a.removeEventListener("timeupdate", fix);
        a.currentTime = 0;
      };
      a.addEventListener("timeupdate", fix);
    }
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const seekTo = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    queueRef.current = [];
    activeRef.current = null;
    setActiveId(null);
    a.currentTime = Math.max(0, t);
    setCurrentTime(a.currentTime);
  };

  const startMarker = (m: Marker) => {
    const a = audioRef.current;
    if (!a) return;
    activeRef.current = m;
    setActiveId(m.id);
    a.currentTime = m.start;
    a.play().catch(() => {});
  };

  const playMarker = (m: Marker) => {
    queueRef.current = [];
    startMarker(m);
  };

  const playAllMarkers = () => {
    if (markers.length === 0) return;
    queueRef.current = markers.slice(1);
    startMarker(markers[0]);
  };

  const stopPlayback = () => {
    queueRef.current = [];
    activeRef.current = null;
    setActiveId(null);
    audioRef.current?.pause();
  };

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setCurrentTime(a.currentTime);
    const m = activeRef.current;
    if (m && a.currentTime >= m.end) {
      const next = queueRef.current.shift();
      if (next) {
        startMarker(next);
      } else {
        activeRef.current = null;
        setActiveId(null);
        a.pause();
      }
    }
  };

  // ---------- Transcripción por partes ----------
  const waitWithStatus = async (seconds: number, label: string) => {
    for (let s = Math.ceil(seconds); s > 0; s--) {
      setProcessStatus(`${label} ${s}s...`);
      await sleep(1000);
    }
  };

  const transcribeChunk = async (idx: number): Promise<ChunkResult> => {
    const audio = samplesRef.current!;
    const [a, b] = planRef.current[idx];
    const from = Math.floor(a * audio.rate);
    const to = Math.min(Math.floor(b * audio.rate), audio.samples.length);
    const blob = wavBlob(audio.samples, audio.rate, from, to);

    let lastMsg = "El servicio de transcripción no responde.";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!navigator.onLine) {
        setProcessStatus("Sin internet. Esperando conexión...");
        while (!navigator.onLine) await sleep(1500);
      }

      let res: Response;
      try {
        const fd = new FormData();
        fd.append("file", blob, `parte-${idx + 1}.wav`);
        res = await fetch("/api/transcribe", { method: "POST", body: fd });
      } catch {
        lastMsg = "Se perdió la conexión con el servidor.";
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        return {
          text: data.text || "",
          segments: (data.segments || []).map((s: Segment) => ({
            start: s.start + a,
            end: s.end + a,
            text: s.text,
          })),
        };
      }

      if (res.status === 429) {
        lastMsg = "Se alcanzó el límite de uso de la transcripción.";
        await waitWithStatus(Math.min(60, (data.retryAfter || 15) + 1), "Límite de uso alcanzado. Reanudando en");
        continue;
      }
      if (res.status >= 500) {
        lastMsg = data.error || "El servicio de transcripción tuvo un problema.";
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 401) throw new Error("La clave de transcripción no es válida. Avisa al administrador.");
      throw new Error(data.error || `Error ${res.status}`);
    }
    throw new Error(lastMsg);
  };

  const transcribeAudio = async () => {
    if (!samplesRef.current) return;
    const plan = planRef.current;
    if (resultsRef.current.length !== plan.length) resultsRef.current = new Array(plan.length).fill(null);
    const results = resultsRef.current;

    setIsProcessing(true);
    setTranscribeError("");
    setTranscription("");
    setSegments([]);

    const pending = plan.map((_, i) => i).filter((i) => !results[i]);
    let done = plan.length - pending.length;
    let next = 0;
    let failure = "";
    setProgress({ done, total: plan.length });
    setProcessStatus(`Transcribiendo parte ${done + 1} de ${plan.length}`);

    const worker = async () => {
      while (!failure) {
        const idx = pending[next++];
        if (idx === undefined) return;
        try {
          results[idx] = await transcribeChunk(idx);
          done++;
          setProgress({ done, total: plan.length });
          setProcessStatus(`Transcribiendo parte ${Math.min(done + 1, plan.length)} de ${plan.length}`);
        } catch (err) {
          failure = err instanceof Error ? err.message : "Fallo al transcribir";
        }
      }
    };

    await Promise.all([worker(), worker()]);

    if (failure || results.some((r) => !r)) {
      setTranscribeError(
        `${failure || "Faltaron partes."} Llevas ${done} de ${plan.length} partes. Pulsa "Continuar" para seguir desde ahí.`
      );
    } else {
      const all = results as ChunkResult[];
      const fullText = all.map((r) => r.text.trim()).filter(Boolean).join(" ") || "No se detectó voz.";
      const allSegs = all.flatMap((r) => r.segments);
      setTranscription(fullText);
      setSegments(allSegs);
      transcriptRef.current = { text: fullText, segments: allSegs };
      saveSession()
        .then((ok) => {
          if (ok) {
            setSaveStatus("saved");
            refreshSessions();
          }
        })
        .catch((e) => {
          setSaveStatus("error");
          setSaveError(e instanceof Error ? e.message : "No se pudo guardar la transcripción.");
        });
    }

    setProcessStatus("");
    setIsProcessing(false);
  };

  // ---------- Marcas y temas con IA ----------
  const findMarkers = async (auto: boolean) => {
    if (segments.length === 0) return;
    if (!auto && !customPrompt.trim()) return;

    const req = ++markersReqRef.current;
    stopPlayback();
    setMarkersLoading(true);
    setMarkersError("");
    setMarkers([]);

    try {
      const response = await fetch("/api/markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: auto ? "" : customPrompt.trim(),
          segments,
          duration: audioDuration,
        }),
      });
      const data = await response.json();
      if (req !== markersReqRef.current) return; // el usuario ya cambió de pestaña
      if (!response.ok) throw new Error(data.error || "Error al generar marcas");
      setMarkers(data.markers || []);
      if ((data.markers || []).length === 0) setMarkersError("No encontré momentos de la clase que respondan eso.");
    } catch (err) {
      if (req !== markersReqRef.current) return;
      setMarkersError(err instanceof Error ? err.message : "Fallo de conexión.");
    } finally {
      if (req === markersReqRef.current) setMarkersLoading(false);
    }
  };

  // ---------- Respuesta con streaming ----------
  const analyzeWithAI = async () => {
    if (!transcription && pdfDocs.length === 0) return;
    if (!customPrompt.trim()) return;

    setIsProcessing(true);
    setProcessStatus("Pensando...");
    setTopicAnalysis("");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: customPrompt.trim(),
          transcription,
          documents: pdfDocs.map((d) => ({ name: d.name, text: d.text })),
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Error al analizar");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let first = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first) {
          setIsProcessing(false);
          setProcessStatus("");
          first = false;
        }
        setTopicAnalysis((prev) => prev + decoder.decode(value, { stream: true }));
      }

      if (first) setTopicAnalysis("La IA devolvió una respuesta vacía. Intenta de nuevo.");
    } catch (err) {
      console.error(err);
      setTopicAnalysis(`❌ ${err instanceof Error ? err.message : "Fallo de conexión."}`);
    } finally {
      setProcessStatus("");
      setIsProcessing(false);
    }
  };

  // ---------- Quiz ----------
  const generateQuiz = async () => {
    if (quizLoading || (!transcription && pdfDocs.length === 0)) return;

    const req = ++quizReqRef.current;
    setQuizLoading(true);
    setQuizError("");
    setQuiz([]);
    setAnswers([]);
    setQIndex(0);
    stopPlayback();

    const hasSeg = segments.length > 0;

    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: customPrompt.trim(),
          count: quizCount,
          transcription: hasSeg ? "" : transcription,
          segments: hasSeg ? segments : [],
          documents: pdfDocs.map((d) => ({ name: d.name, text: d.text })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (req !== quizReqRef.current) return;
      if (!res.ok) throw new Error(data.error || "Error al generar el quiz");
      const qs: QuizQ[] = data.questions || [];
      setQuiz(qs);
      setAnswers(new Array(qs.length).fill(null));
      setQIndex(0);
    } catch (err) {
      if (req !== quizReqRef.current) return;
      setQuizError(err instanceof Error ? err.message : "Fallo de conexión.");
    } finally {
      if (req === quizReqRef.current) setQuizLoading(false);
    }
  };

  const pickAnswer = (i: number) => {
    if (answers[qIndex] !== null && answers[qIndex] !== undefined) return;
    setAnswers((prev) => {
      const c = [...prev];
      c[qIndex] = i;
      return c;
    });
  };

  const nextQuestion = () => {
    stopPlayback();
    setQIndex((i) => i + 1);
  };

  const exitQuiz = () => {
    quizReqRef.current++;
    stopPlayback();
    setQuiz([]);
    setAnswers([]);
    setQIndex(0);
    setQuizError("");
    setQuizLoading(false);
  };

  const retryQuiz = () => {
    stopPlayback();
    setAnswers(new Array(quiz.length).fill(null));
    setQIndex(0);
  };

  const playSource = (at: number) => {
    startMarker({ id: -1, start: Math.max(0, at - 3), end: at + 30, title: "", summary: "" });
  };

  // ---------- Texto a voz ----------
  const toggleSpeech = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      alert("Tu navegador no soporta la lectura en voz alta.");
      return;
    }
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    } else {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "es-CO";
      utterance.rate = 1.0;
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
      setIsSpeaking(true);
    }
  };

  // ---------- Dictado ----------
  const startRecordDictation = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      dictRecRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) parts.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (dictTimeoutRef.current) clearTimeout(dictTimeoutRef.current);
        const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1000) {
          setDictState("idle");
          return;
        }
        setDictState("busy");
        try {
          const fd = new FormData();
          fd.append("file", blob, "pregunta.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Error al transcribir");
          const text = String(data.text || "").trim();
          if (text) setCustomPrompt((p) => (p.trim() ? p.trim() + " " : "") + text);
        } catch (err) {
          alert(err instanceof Error ? err.message : "No se pudo transcribir tu voz.");
        } finally {
          setDictState("idle");
        }
      };

      rec.start();
      setDictState("rec");
      dictTimeoutRef.current = setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, 60000);
    } catch {
      setDictState("idle");
      alert("Permite el acceso al micrófono para dictar.");
    }
  };

  const startLiveDictation = (SR: any) => {
    const rec = new SR();
    rec.lang = "es-CO";
    rec.interimResults = true;
    rec.continuous = true;
    const base = customPrompt.trim() ? customPrompt.trim() + " " : "";
    liveStartRef.current = Date.now();
    liveGotResultRef.current = false;
    liveStoppedByUserRef.current = false;

    rec.onresult = (e: any) => {
      liveGotResultRef.current = true;
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setCustomPrompt((base + finalText + interim).trimStart());
    };

    const fallback = () => {
      dictFallbackRef.current = true;
      setDictState("idle");
      startRecordDictation();
    };

    rec.onerror = (e: any) => {
      if (["network", "service-not-allowed", "language-not-supported"].includes(e.error)) {
        fallback();
      } else if (e.error === "not-allowed") {
        setDictState("idle");
        alert("Permite el acceso al micrófono para dictar.");
      }
    };
    rec.onend = () => {
      setDictState((s) => {
        if (s !== "live") return s;
        if (!liveStoppedByUserRef.current && !liveGotResultRef.current && Date.now() - liveStartRef.current < 2500) {
          fallback();
          return "idle";
        }
        return "idle";
      });
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setDictState("live");
    } catch {
      fallback();
    }
  };

  const toggleDictation = () => {
    if (dictState === "busy") return;
    if (dictState === "live") {
      liveStoppedByUserRef.current = true;
      recognitionRef.current?.stop();
      return;
    }
    if (dictState === "rec") {
      if (dictRecRef.current && dictRecRef.current.state !== "inactive") dictRecRef.current.stop();
      return;
    }

    audioRef.current?.pause();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR && !dictFallbackRef.current) startLiveDictation(SR);
    else startRecordDictation();
  };

  // ---------- Cambiar de pestaña ----------
  const hasSegments = segments.length > 0;
  const hasMaterial = !!transcription || pdfDocs.length > 0;

  const selectMode = (m: Mode) => {
    if (m === mode) return;
    markersReqRef.current++; // cancela búsquedas en curso de la pestaña anterior
    stopPlayback();
    setMarkers([]);
    setMarkersError("");
    setMarkersLoading(false);
    setTopicAnalysis("");
    setCustomPrompt("");
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setMode(m);
    if (m === "topics") findMarkers(true); // un solo clic: detecta los temas
  };

  // ---------- Enviar según el modo ----------
  const canSubmit =
    !isProcessing &&
    !markersLoading &&
    (mode === "topics"
      ? false
      : mode === "quiz"
      ? hasMaterial && !quizLoading
      : mode === "markers"
      ? hasSegments && customPrompt.trim().length > 0
      : customPrompt.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    if (dictState === "live") {
      liveStoppedByUserRef.current = true;
      recognitionRef.current?.stop();
    }
    if (mode === "answer") analyzeWithAI();
    else if (mode === "markers") findMarkers(false);
    else if (mode === "quiz") generateQuiz();
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1500);
  };

  const placeholder =
    dictState === "live"
      ? "Escuchando... habla ahora"
      : dictState === "rec"
      ? "Grabando tu pregunta... toca el micrófono al terminar"
      : dictState === "busy"
      ? "Transcribiendo tu voz..."
      : mode === "answer"
      ? "Pregunta lo que quieras sobre la clase"
      : mode === "quiz"
      ? "Tema opcional, ej: cadencias. Vacío = todo el material"
      : "¿Qué momento buscas? Ej: cuando habló de cadencias";

  const suggestions =
    mode === "answer"
      ? ["Resume la clase", "¿Cuáles son las ideas clave?", "¿Qué tareas dejaron?"]
      : ["Cuando explicó un ejemplo", "Cuando dejaron tarea", "Cuando hicieron preguntas"];

  const showAsk = hasMaterial && !isRecording;

  const modes: { id: Mode; label: string; needsSegments: boolean }[] = [
    { id: "answer", label: "Preguntar", needsSegments: false },
    { id: "markers", label: "Marcar", needsSegments: true },
    { id: "topics", label: "Temas", needsSegments: true },
    { id: "quiz", label: "Quiz", needsSegments: false },
  ];

  // ---------- Alertas ----------
  const notices: Notice[] = [];
  if (!online)
    notices.push({
      level: "error",
      text: "Sin conexión. Puedes seguir grabando, pero transcribir y preguntar necesitan internet.",
    });
  if (micLost)
    notices.push({
      level: "error",
      text: "El micrófono se desconectó. La grabación se detuvo y se conservó lo grabado hasta ahí.",
    });
  if (isRecording)
    notices.push({ level: "info", text: "No cierres ni recargues esta pestaña mientras grabas." });
  if (isRecording && MAX_SECONDS - recordingTime <= WARN_REMAINING)
    notices.push({
      level: "warn",
      text: `Quedan ${Math.max(1, Math.ceil((MAX_SECONDS - recordingTime) / 60))} min del máximo de 2 horas. La grabación se detendrá sola.`,
    });
  if (isRecording && batteryLow)
    notices.push({ level: "warn", text: "Batería baja. Conecta el cargador para no perder la clase." });
  if (online && health && !health.groq)
    notices.push({
      level: "warn",
      text: "La transcripción no responde ahora. Puedes grabar y transcribir más tarde sin cerrar la pestaña.",
    });
  if (online && health && !health.gemini)
    notices.push({ level: "warn", text: "La IA de preguntas no responde ahora. Las respuestas pueden fallar." });
  if (saveStatus === "error")
    notices.push({ level: "warn", text: saveError || "No se pudo guardar la clase en la nube." });

  const noticeStyle: Record<Notice["level"], { box: string; dot: string }> = {
    error: { box: "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200", dot: "bg-red-500" },
    warn: { box: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200", dot: "bg-amber-500" },
    info: { box: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400", dot: "bg-zinc-400" },
  };

  const dictActive = dictState === "live" || dictState === "rec";
  const resultsVisible =
    showAsk && (mode === "markers" || mode === "topics") && (markersLoading || markers.length > 0 || !!markersError);

  // Estado del quiz
  const quizFinished = quiz.length > 0 && qIndex >= quiz.length;
  const currentQ = quiz[qIndex];
  const picked = answers[qIndex] ?? null;
  const score = quiz.reduce((s, q, i) => s + (answers[i] === q.correct ? 1 : 0), 0);
  const showQuizConfig = mode === "quiz" && quiz.length === 0 && !quizLoading;
  const showInput = mode === "answer" || mode === "markers" || showQuizConfig;

  const optionClass = (i: number) => {
    if (!currentQ) return "";
    if (picked === null)
      return "border-zinc-200 bg-white hover:border-violet-300 hover:bg-violet-50/60 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-violet-800 dark:hover:bg-violet-950/30";
    if (i === currentQ.correct)
      return "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100";
    if (i === picked)
      return "border-red-400 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100";
    return "border-zinc-200 opacity-50 dark:border-zinc-800";
  };

  return (
    <div className="min-h-dvh bg-white font-sans text-zinc-900 antialiased transition-colors duration-300 dark:bg-black dark:text-zinc-100">
      <main className="mx-auto w-full max-w-7xl px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-6 sm:pt-8 lg:px-8">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Transcriptor + IA</h1>
          <div className="flex items-center gap-3">
            {isRecording && (
              <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                <span className="hidden sm:inline">Grabando</span>
              </span>
            )}
            <button
              onClick={() => setIsDarkMode((d) => !d)}
              className={`flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 ${focusRing}`}
              aria-label={isDarkMode ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
              title={isDarkMode ? "Modo claro" : "Modo oscuro"}
            >
              {isDarkMode ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </header>

        {notices.length > 0 && (
          <div className="mb-6 space-y-2" role="status" aria-live="polite">
            {notices.map((n, i) => (
              <p key={i} className={`flex items-start gap-2.5 rounded-2xl px-4 py-3 text-[13px] leading-snug ${noticeStyle[n.level].box}`}>
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${noticeStyle[n.level].dot}`} />
                <span>{n.text}</span>
              </p>
            ))}
          </div>
        )}

        <div className="lg:grid lg:grid-cols-12 lg:items-start lg:gap-8">
          {/* COLUMNA IZQUIERDA: Audio y Transcripción */}
          <div className="space-y-6 lg:col-span-5">
            <section aria-label="Audio">
              {isRecording && (
                <div className="space-y-6 rounded-3xl bg-zinc-50 p-5 dark:bg-zinc-900/60 sm:p-6">
                  <Waveform peaks={peaksRef.current} version={peaksVersion} duration={0} currentTime={0} markers={[]} activeId={null} live height={72} dark={isDarkMode} />
                  <div className="flex flex-col items-center gap-4">
                    <span className="font-mono text-4xl font-light tabular-nums tracking-tight">{fmt(recordingTime)}</span>
                    <button onClick={stopRecording} className={`flex h-16 w-16 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 ${focusRing}`} aria-label="Detener grabación">
                      <StopIcon />
                    </button>
                  </div>
                </div>
              )}

              {!isRecording && !audioUrl && (
                <div className="flex flex-col items-center gap-5 py-10 sm:py-14">
                  <div className="relative">
                    <span className="absolute inset-0 animate-ping rounded-full bg-red-500/20 motion-reduce:hidden" style={{ animationDuration: "2.8s" }} />
                    <button onClick={startRecording} className={`relative flex h-24 w-24 items-center justify-center rounded-full bg-red-600 text-white shadow-xl shadow-red-600/25 transition hover:scale-105 hover:bg-red-700 active:scale-95 ${focusRing}`} aria-label="Grabar clase">
                      <MicIcon size={34} />
                    </button>
                  </div>
                  <div className="space-y-1 text-center">
                    <p className="text-base font-medium">Grabar clase</p>
                    <p className="text-sm text-zinc-500">Hasta 2 horas de audio</p>
                  </div>
                  <button onClick={() => audioInputRef.current?.click()} className={`inline-flex h-11 items-center gap-2 rounded-full border border-zinc-200 px-5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 ${focusRing}`}>
                    <UploadIcon />
                    Subir un audio
                  </button>
                  <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={handleAudioUpload} />
                </div>
              )}

              {!isRecording && audioUrl && (
                <div className="space-y-5">
                  <div className="rounded-3xl bg-zinc-50 p-4 dark:bg-zinc-900/60 sm:p-5">
                    <div className="flex items-center gap-3 sm:gap-4">
                      <button onClick={togglePlay} className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700 active:scale-95 ${focusRing}`} aria-label={isPlaying ? "Pausar" : "Reproducir"}>
                        {isPlaying ? <PauseIcon /> : <PlayIcon />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <Waveform peaks={peaksRef.current} version={peaksVersion} duration={audioDuration} currentTime={currentTime} markers={markers} activeId={activeId} onSeek={seekTo} dark={isDarkMode} />
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="flex items-center gap-3">
                        <span className="font-mono text-xs tabular-nums text-zinc-500">
                          {fmt(currentTime)} / {fmt(audioDuration)}
                        </span>
                        {saveStatus === "saving" && <span className="text-xs text-zinc-500">Guardando en la nube…</span>}
                        {saveStatus === "saved" && <span className="text-xs text-emerald-600 dark:text-emerald-400">Guardada ✓</span>}
                        {saveStatus === "error" && (
                          <button onClick={retrySave} className={`${linkBtn} !text-amber-700 dark:!text-amber-300`}>
                            No se guardó · Reintentar
                          </button>
                        )}
                      </span>
                      <button onClick={resetRecording} className={linkBtn}>
                        Empezar de nuevo
                      </button>
                    </div>
                  </div>

                  <audio ref={audioRef} src={audioUrl} hidden onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onTimeUpdate} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} />

                  {preparing && (
                    <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                      <Spinner />
                      <span>Preparando audio...</span>
                    </div>
                  )}
                  {prepareError && <p className="text-center text-sm leading-snug text-red-600 dark:text-red-400">{prepareError}</p>}

                  {audioReady && !transcription && !isProcessing && (
                    <button onClick={transcribeAudio} className={primaryBtn}>
                      {progress.done > 0 ? "Continuar transcripción" : "Transcribir clase"}
                    </button>
                  )}
                  {transcribeError && <p className="text-center text-sm leading-snug text-red-600 dark:text-red-400">{transcribeError}</p>}
                </div>
              )}
            </section>

            {!isRecording && !audioUrl && (sessions.length > 0 || sessionsLoading || !!sessionsError) && (
              <section className="space-y-3" aria-label="Clases guardadas">
                <h2 className="px-1 text-sm font-medium text-zinc-600 dark:text-zinc-400">Clases guardadas</h2>
                {sessionsLoading && sessions.length === 0 && (
                  <div className="flex items-center gap-2 px-1 text-sm text-zinc-500">
                    <Spinner />
                    <span>Cargando...</span>
                  </div>
                )}
                {sessionsError && <p className="px-1 text-sm text-zinc-500">{sessionsError}</p>}
                {sessions.length > 0 && (
                  <div className="max-h-80 overflow-y-auto overscroll-contain pr-1">
                    <ul className="space-y-2">
                      {sessions.map((s) => (
                        <li key={s.id} className="flex items-center gap-1 rounded-2xl bg-zinc-50 p-1 dark:bg-zinc-900/60">
                          <button
                            onClick={() => openSession(s.id)}
                            disabled={!!openingId}
                            className={`flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-2.5 text-left transition hover:bg-zinc-100 disabled:opacity-60 dark:hover:bg-zinc-900 ${focusRing}`}
                          >
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300">
                              {openingId === s.id ? <Spinner /> : <PlayIcon size={16} />}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{s.title}</span>
                              <span className="block text-xs text-zinc-500">
                                {fmt(s.duration)} · {s.hasTranscript ? "transcrita" : "sin transcribir"}
                              </span>
                            </span>
                          </button>
                          <button
                            onClick={() => deleteSession(s.id)}
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:text-red-500 ${focusRing}`}
                            aria-label={`Borrar ${s.title}`}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {transcription && (
              <section className="rounded-3xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-6">
                <details className="group">
                  <summary className="flex min-h-[3rem] cursor-pointer list-none items-center justify-between text-sm font-medium text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                    <span>Ver transcripción completa</span>
                    <ChevronIcon />
                  </summary>
                  <div className="space-y-3 pb-1 pt-3">
                    <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                      {transcription}
                    </p>
                    <button onClick={() => copyToClipboard(transcription, "tr")} className={linkBtn}>
                      {copied === "tr" ? "Copiado ✓" : "Copiar transcripción"}
                    </button>
                  </div>
                </details>
              </section>
            )}
          </div>

          {/* COLUMNA DERECHA: Interacción, IA y PDFs */}
          <div className="mt-8 space-y-6 lg:col-span-7 lg:mt-0">
            {isProcessing && (
              <div className="space-y-3 rounded-3xl bg-violet-50 p-5 dark:bg-violet-950/20" role="status" aria-live="polite">
                <div className="flex items-center justify-center gap-2 text-sm font-medium text-violet-700 dark:text-violet-300">
                  <Spinner className="border-violet-600 dark:border-violet-400" />
                  <span>{processStatus}</span>
                </div>
                {progress.total > 1 && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-violet-200 dark:bg-violet-900">
                    <div className="h-full rounded-full bg-violet-600 transition-all duration-500" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                  </div>
                )}
              </div>
            )}

            {showAsk && (
              <section className="space-y-4" aria-label="Herramientas de la clase">
                <div className="grid grid-cols-4 rounded-full bg-zinc-100 p-1 dark:bg-zinc-900" role="tablist">
                  {modes.map((m) => {
                    const disabled = m.needsSegments && !hasSegments;
                    const active = mode === m.id;
                    return (
                      <button
                        key={m.id}
                        role="tab"
                        aria-selected={active}
                        onClick={() => !disabled && selectMode(m.id)}
                        disabled={disabled}
                        title={disabled ? "Necesita una clase transcrita desde el audio" : undefined}
                        className={`h-10 rounded-full text-[13px] font-medium transition sm:text-sm ${focusRing} ${
                          active
                            ? "bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300"
                            : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                        } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>

                {/* Quiz: cantidad de preguntas */}
                {showQuizConfig && (
                  <div className="flex items-center justify-between gap-3 px-1">
                    <span className="text-sm text-zinc-500">Número de preguntas</span>
                    <div className="flex gap-2">
                      {[5, 10, 15].map((n) => (
                        <button
                          key={n}
                          onClick={() => setQuizCount(n)}
                          aria-pressed={quizCount === n}
                          className={`h-9 w-11 rounded-full border text-sm font-medium transition ${focusRing} ${
                            quizCount === n
                              ? "border-violet-500 bg-violet-50 text-violet-700 dark:border-violet-600 dark:bg-violet-950/40 dark:text-violet-300"
                              : "border-zinc-200 text-zinc-600 hover:border-violet-300 dark:border-zinc-800 dark:text-zinc-400"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {showInput && (
                  <>
                    <div className={`flex items-end gap-1.5 rounded-3xl border bg-white p-2 transition dark:bg-zinc-950 ${dictActive ? "border-red-400 ring-4 ring-red-400/10" : "border-zinc-200 focus-within:border-violet-500 focus-within:ring-4 focus-within:ring-violet-500/10 dark:border-zinc-800"}`}>
                      <textarea
                        ref={promptRef}
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            submit();
                          }
                        }}
                        placeholder={placeholder}
                        rows={1}
                        aria-label={mode === "answer" ? "Tu pregunta" : mode === "quiz" ? "Tema del quiz (opcional)" : "Momento que buscas"}
                        className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent px-3 py-3 text-base leading-snug outline-none placeholder:text-zinc-400 sm:text-[15px]"
                      />
                      {canDictate && (
                        <button
                          onClick={toggleDictation}
                          disabled={dictState === "busy"}
                          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition ${focusRing} ${
                            dictActive ? "animate-pulse bg-red-600 text-white" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          } ${dictState === "busy" ? "opacity-60" : ""}`}
                          aria-label={dictActive ? "Detener dictado" : "Dictar"}
                          title="Dictar"
                        >
                          {dictState === "busy" ? <Spinner /> : <MicIcon />}
                        </button>
                      )}
                      {mode !== "quiz" && (
                        <button
                          onClick={submit}
                          disabled={!canSubmit}
                          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
                          aria-label="Enviar"
                        >
                          <SendIcon />
                        </button>
                      )}
                    </div>

                    {mode === "quiz" && (
                      <button onClick={submit} disabled={!canSubmit} className={primaryBtn}>
                        Generar {quizCount} preguntas
                      </button>
                    )}

                    {mode !== "quiz" && !customPrompt.trim() && !topicAnalysis && !resultsVisible && (mode === "answer" || hasSegments) && (
                      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            onClick={() => {
                              setCustomPrompt(s);
                              promptRef.current?.focus();
                            }}
                            className={`h-9 shrink-0 rounded-full border border-zinc-200 px-4 text-[13px] text-zinc-600 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-violet-800 dark:hover:bg-violet-950/40 dark:hover:text-violet-300 ${focusRing}`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {/* Respuesta (Preguntar) */}
            {showAsk && mode === "answer" && topicAnalysis && (
              <section className="space-y-4 rounded-3xl bg-zinc-50 p-5 dark:bg-zinc-900/60 sm:p-6">
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed sm:leading-7">{topicAnalysis}</p>
                <div className="flex flex-wrap gap-4">
                  <button onClick={() => copyToClipboard(topicAnalysis, "answer")} className={linkBtn}>
                    {copied === "answer" ? "Copiado ✓" : "Copiar"}
                  </button>
                  <button onClick={() => toggleSpeech(topicAnalysis)} className={`${linkBtn} flex items-center gap-1.5`}>
                    {isSpeaking ? <PauseIcon size={14} /> : <SpeakerIcon size={14} />}
                    {isSpeaking ? "Detener audio" : "Escuchar respuesta"}
                  </button>
                  <button
                    onClick={() => {
                      setTopicAnalysis("");
                      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
                      setIsSpeaking(false);
                    }}
                    className={linkBtn}
                  >
                    Limpiar
                  </button>
                </div>
              </section>
            )}

            {/* Resultados de Marcar y Temas (con scroll propio) */}
            {resultsVisible && (
              <section className="space-y-3" aria-live="polite">
                {markersLoading && (
                  <div className="flex items-center justify-center gap-2 py-2 text-sm text-zinc-600 dark:text-zinc-400">
                    <Spinner />
                    <span>{mode === "topics" ? "Detectando los temas de la clase..." : "Buscando momentos..."}</span>
                  </div>
                )}
                {markersError && (
                  <div className="space-y-2 text-center">
                    <p className="text-sm text-red-600 dark:text-red-400">{markersError}</p>
                    {mode === "topics" && (
                      <button onClick={() => findMarkers(true)} className={`${linkBtn} !text-violet-700 dark:!text-violet-300`}>
                        Reintentar
                      </button>
                    )}
                  </div>
                )}

                {markers.length > 0 && (
                  <>
                    <div className="flex items-center justify-between px-1">
                      <span className="text-sm text-zinc-500">
                        {markers.length} {mode === "topics" ? (markers.length === 1 ? "tema" : "temas") : markers.length === 1 ? "momento" : "momentos"}
                      </span>
                      <div className="flex gap-4">
                        <button onClick={playAllMarkers} className={`${linkBtn} font-medium !text-violet-700 dark:!text-violet-300`}>
                          Reproducir todos
                        </button>
                        <button onClick={stopPlayback} className={linkBtn}>
                          Parar
                        </button>
                      </div>
                    </div>

                    <div className="max-h-96 overflow-y-auto overscroll-contain pr-1">
                      <ul className="space-y-2">
                        {markers.map((m) => {
                          const active = m.id === activeId;
                          return (
                            <li key={m.id}>
                              <button
                                onClick={() => (active ? stopPlayback() : playMarker(m))}
                                aria-pressed={active}
                                className={`flex w-full items-start gap-3 rounded-2xl p-3.5 text-left transition ${focusRing} ${
                                  active
                                    ? "bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-950/40 dark:ring-violet-800"
                                    : "bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900/60 dark:hover:bg-zinc-900"
                                }`}
                              >
                                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${active ? "bg-violet-600 text-white" : "bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300"}`}>
                                  {active ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-baseline justify-between gap-3">
                                    <span className="text-sm font-medium leading-snug">{m.title}</span>
                                    <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-500">{fmt(m.start)}</span>
                                  </span>
                                  {m.summary && <span className="mt-1 block text-[13px] leading-snug text-zinc-600 dark:text-zinc-400">{m.summary}</span>}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </>
                )}
              </section>
            )}

            {/* Quiz */}
            {showAsk && mode === "quiz" && quizLoading && (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-600 dark:text-zinc-400" role="status">
                <Spinner />
                <span>Preparando preguntas con tu material...</span>
              </div>
            )}

            {showAsk && mode === "quiz" && quizError && !quizLoading && (
              <p className="text-center text-sm text-red-600 dark:text-red-400">{quizError}</p>
            )}

            {showAsk && mode === "quiz" && currentQ && !quizFinished && (
              <section className="space-y-5 rounded-3xl bg-zinc-50 p-5 dark:bg-zinc-900/60 sm:p-6" aria-live="polite">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>
                      Pregunta {qIndex + 1} de {quiz.length}
                    </span>
                    <button onClick={exitQuiz} className={linkBtn}>
                      Salir
                    </button>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div className="h-full rounded-full bg-violet-600 transition-all duration-300" style={{ width: `${(qIndex / quiz.length) * 100}%` }} />
                  </div>
                </div>

                <p className="text-base font-medium leading-snug">{currentQ.question}</p>

                <div className="space-y-2" role="radiogroup" aria-label="Opciones">
                  {currentQ.options.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => pickAnswer(i)}
                      disabled={picked !== null}
                      role="radio"
                      aria-checked={picked === i}
                      className={`flex w-full items-start gap-3 rounded-2xl border p-3.5 text-left text-sm leading-snug transition ${focusRing} ${optionClass(i)}`}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {picked !== null && i === currentQ.correct ? <CheckIcon /> : picked === i ? <CrossIcon /> : LETTERS[i]}
                      </span>
                      <span className="min-w-0 flex-1 pt-0.5">{opt}</span>
                    </button>
                  ))}
                </div>

                {picked !== null && (
                  <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm dark:bg-zinc-950" aria-live="polite">
                    <p className={`text-sm font-semibold ${picked === currentQ.correct ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>
                      {picked === currentQ.correct ? "¡Correcto!" : `Incorrecto. La respuesta era ${LETTERS[currentQ.correct]}.`}
                    </p>
                    {currentQ.explanation && <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">{currentQ.explanation}</p>}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {currentQ.ref && <span className="text-xs text-zinc-500">Fuente: {currentQ.ref}</span>}
                      {currentQ.at !== null && audioUrl && (
                        <button
                          onClick={() => (activeId === -1 ? stopPlayback() : playSource(currentQ.at as number))}
                          className={`${linkBtn} flex items-center gap-1.5 font-medium !text-violet-700 dark:!text-violet-300`}
                        >
                          {activeId === -1 ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                          {activeId === -1 ? "Detener" : `Escuchar ese momento (${fmt(currentQ.at)})`}
                        </button>
                      )}
                    </div>
                    <button onClick={nextQuestion} className={primaryBtn}>
                      {qIndex + 1 === quiz.length ? "Ver resultado" : "Siguiente"}
                    </button>
                  </div>
                )}
              </section>
            )}

            {showAsk && mode === "quiz" && quizFinished && (
              <section className="space-y-5 rounded-3xl bg-zinc-50 p-5 dark:bg-zinc-900/60 sm:p-6" aria-live="polite">
                <div className="space-y-1 text-center">
                  <p className="text-4xl font-light tabular-nums">
                    {score}
                    <span className="text-xl text-zinc-400"> / {quiz.length}</span>
                  </p>
                  <p className="text-sm text-zinc-500">
                    {score === quiz.length
                      ? "¡Perfecto! Dominas este material."
                      : score >= quiz.length * 0.7
                      ? "Muy bien. Repasa los fallos de abajo."
                      : "Vale la pena repasar el material y volver a intentarlo."}
                  </p>
                </div>

                {score < quiz.length && (
                  <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-1">
                    {quiz.map((q, i) =>
                      answers[i] !== q.correct ? (
                        <div key={i} className="space-y-1 rounded-2xl bg-white p-3.5 text-sm shadow-sm dark:bg-zinc-950">
                          <p className="font-medium leading-snug">{q.question}</p>
                          <p className="text-[13px] text-emerald-700 dark:text-emerald-300">Correcta: {q.options[q.correct]}</p>
                          {answers[i] !== null && answers[i] !== undefined && (
                            <p className="text-[13px] text-red-700 dark:text-red-300">Tu respuesta: {q.options[answers[i] as number]}</p>
                          )}
                          {q.ref && <p className="text-xs text-zinc-500">Fuente: {q.ref}</p>}
                        </div>
                      ) : null
                    )}
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <button onClick={retryQuiz} className={`${primaryBtn} !bg-white !text-violet-700 ring-1 ring-violet-300 hover:!bg-violet-50 dark:!bg-zinc-950 dark:!text-violet-300 dark:ring-violet-800 dark:hover:!bg-violet-950/30`}>
                    Repetir las mismas
                  </button>
                  <button onClick={exitQuiz} className={primaryBtn}>
                    Nuevo quiz
                  </button>
                </div>
              </section>
            )}

            <section className="rounded-3xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-6">
              <details className="group">
                <summary className="flex min-h-[3rem] cursor-pointer list-none items-center justify-between text-sm font-medium text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                  <span>
                    Documentos de apoyo
                    {pdfDocs.length > 0 && (
                      <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                        {pdfDocs.length}
                      </span>
                    )}
                  </span>
                  <ChevronIcon />
                </summary>
                <div className="space-y-3 pb-1 pt-3">
                  <input type="file" accept="application/pdf" multiple ref={fileInputRef} onChange={handleFileChange} disabled={readingPdf} hidden />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={readingPdf || pdfDocs.length >= 5}
                    className={`flex w-full flex-col items-center gap-1 rounded-2xl border border-dashed border-zinc-300 px-4 py-5 text-sm text-zinc-600 transition hover:border-violet-400 hover:bg-violet-50/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-violet-700 dark:hover:bg-violet-950/20 ${focusRing}`}
                  >
                    <span className="inline-flex items-center gap-2 font-medium">
                      <UploadIcon />
                      Añadir PDF
                    </span>
                    <span className="text-xs text-zinc-400">Hasta 5 con texto. Se leen en tu navegador.</span>
                  </button>
                  {readingPdf && (
                    <div className="flex items-center gap-2 text-sm text-zinc-500">
                      <Spinner />
                      <span>Leyendo PDF...</span>
                    </div>
                  )}
                  {pdfDocs.length > 0 && (
                    <ul className="space-y-1.5">
                      {pdfDocs.map((doc, index) => (
                        <li key={index} className="flex items-center justify-between gap-2 rounded-xl bg-white py-2 pl-3 pr-1 text-sm shadow-sm dark:bg-zinc-900">
                          <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">
                            {doc.name} <span className="text-xs text-zinc-400">· {doc.pages} pág.</span>
                          </span>
                          <button onClick={() => removePdf(index)} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:text-red-500 ${focusRing}`} aria-label={`Quitar ${doc.name}`}>
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}