"use client";

import { useState, useRef, useEffect } from "react";

type PdfDoc = { name: string; size: number; pages: number; text: string };
type Segment = { start: number; end: number; text: string };
type Marker = { id: number; start: number; end: number; title: string; summary: string };
type Mode = "answer" | "markers" | "topics";

const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = m.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

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
  const total = duration > 0 ? duration : peaks.length * 0.2 || 1;

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

    // En vivo: se muestran los últimos segundos, desplazándose hacia la izquierda
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

  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState("");
  const [transcribeError, setTranscribeError] = useState("");

  const [transcription, setTranscription] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [topicAnalysis, setTopicAnalysis] = useState("");
  const [mode, setMode] = useState<Mode>("answer");

  const [pdfDocs, setPdfDocs] = useState<PdfDoc[]>([]);
  const [readingPdf, setReadingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Onda, reproducción y marcas
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [markersLoading, setMarkersLoading] = useState(false);
  const [markersError, setMarkersError] = useState("");

  // Dictado por voz
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<any>(null);

  const peaksRef = useRef<number[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<Marker[]>([]);
  const activeRef = useRef<Marker | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peakTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechSupported(!!SR);
  }, []);

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

  // ---------- Grabación ----------
  const startRecording = async () => {
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
        peaksRef.current.push(Math.min(1, dev * 3)); // un punto cada 200 ms
        setPeaksVersion((v) => v + 1);
      }, 200);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setAudioDuration(peaksRef.current.length * 0.2);
        setPeaksVersion((v) => v + 1);
        setTranscription("");
        setTopicAnalysis("");
        stream.getTracks().forEach((t) => t.stop());
        if (peakTimerRef.current) clearInterval(peakTimerRef.current);
        audioCtxRef.current?.close();
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((p) => p + 1), 1000);
    } catch {
      alert("No se pudo acceder al micrófono. Concede los permisos necesarios.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setTranscription("");
    setTranscribeError("");
    setSegments([]);
    setMarkers([]);
    setMarkersError("");
    setActiveId(null);
    activeRef.current = null;
    queueRef.current = [];
    peaksRef.current = [];
    setPeaksVersion((v) => v + 1);
    setAudioDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setTopicAnalysis("");
    setCustomPrompt("");
    setRecordingTime(0);
    setMode("answer");
  };

  // ---------- Reproducción y marcas ----------
  // Los audios de MediaRecorder no traen duración: este truco habilita el "seek"
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

  // ---------- Transcripción ----------
  const transcribeAudio = async () => {
    if (!audioBlob) return;
    setIsProcessing(true);
    setProcessStatus("Transcribiendo la clase...");
    setTranscribeError("");
    setTranscription("");
    setSegments([]);

    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");

      const response = await fetch("/api/transcribe", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Error en la transcripción");

      setTranscription(data.text || "No se detectó voz.");
      setSegments(data.segments || []);
    } catch (err) {
      console.error(err);
      setTranscribeError(err instanceof Error ? err.message : "Fallo al transcribir");
    } finally {
      setProcessStatus("");
      setIsProcessing(false);
    }
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

  // ---------- Dictado por voz ----------
  const toggleDictation = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;

    audioRef.current?.pause(); // que la clase no se cuele en el dictado

    const rec = new SR();
    rec.lang = "es-CO";
    rec.interimResults = true;
    rec.continuous = true;

    const base = customPrompt.trim() ? customPrompt.trim() + " " : "";

    rec.onresult = (e: any) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setCustomPrompt((base + finalText + interim).trimStart());
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e: any) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        alert("Permite el acceso al micrófono para dictar.");
      }
    };

    recognitionRef.current = rec;
    rec.start();
    setListening(true);
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
    if (listening) recognitionRef.current?.stop();
    if (mode === "answer") analyzeWithAI();
    else if (mode === "markers") findMarkers(false);
    else findMarkers(true);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const placeholder = listening
    ? "Escuchando... habla ahora"
    : mode === "answer"
    ? "Pregunta lo que quieras sobre la clase"
    : "¿Qué momento buscas? Ej: cuando habló de cadencias";

  const showAsk = (transcription || pdfDocs.length > 0) && !isRecording;

  const modes: { id: Mode; label: string; needsSegments: boolean }[] = [
    { id: "answer", label: "Preguntar", needsSegments: false },
    { id: "markers", label: "Marcar", needsSegments: true },
    { id: "topics", label: "Temas", needsSegments: true },
  ];

  return (
    <div className="flex min-h-screen justify-center bg-white px-5 py-10 font-sans text-zinc-900 dark:bg-black dark:text-zinc-100">
      <main className="w-full max-w-xl space-y-8">
        <h1 className="text-center text-xl font-semibold tracking-tight">Transcriptor + IA</h1>

        {/* ============ ETAPA PRINCIPAL ============ */}
        <section>
          {/* Grabando */}
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

          {/* Sin audio: botón único */}
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
            </div>
          )}

          {/* Audio grabado: play + onda */}
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
                  Descartar y grabar otra
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

              {!transcription && !isProcessing && (
                <button
                  onClick={transcribeAudio}
                  className="w-full rounded-full bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-violet-700"
                >
                  Transcribir clase
                </button>
              )}
              {transcribeError && <p className="text-center text-sm text-red-600 dark:text-red-400">{transcribeError}</p>}
            </div>
          )}
        </section>

        {/* Estado de proceso (transcribiendo / pensando) */}
        {isProcessing && (
          <div className="flex items-center justify-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Spinner />
            <span>{processStatus}</span>
          </div>
        )}

        {/* ============ PREGUNTAR / MARCAR / TEMAS ============ */}
        {showAsk && (
          <section className="space-y-4">
            {/* Selector: una opción a la vez */}
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

            {/* Entrada (en "Temas" no hace falta escribir) */}
            {mode !== "topics" ? (
              <div
                className={`flex items-end gap-2 rounded-2xl border bg-white p-2 transition dark:bg-zinc-950 ${
                  listening ? "border-red-400 ring-2 ring-red-400/20" : "border-zinc-300 focus-within:border-violet-500 dark:border-zinc-700"
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
                {speechSupported && (
                  <button
                    onClick={toggleDictation}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
                      listening
                        ? "animate-pulse bg-red-600 text-white"
                        : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                    aria-label={listening ? "Detener dictado" : "Dictar pregunta"}
                    title={listening ? "Detener dictado" : "Dictar pregunta"}
                  >
                    <MicIcon />
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

        {/* ============ RESULTADO (solo el del modo activo) ============ */}
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

        {/* ============ SECUNDARIO: PLEGADO ============ */}
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
}