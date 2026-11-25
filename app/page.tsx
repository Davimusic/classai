"use client";

import { useState, useRef, useEffect } from "react";

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState<string>("");

  const [transcription, setTranscription] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [topicAnalysis, setTopicAnalysis] = useState<string>("");

  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [audioUrl]);

  // ---------- PDFs ----------
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validPdfs = files.filter((file) => file.type === "application/pdf");

    if (validPdfs.length !== files.length) alert("Solo se permiten archivos PDF.");
    if (pdfFiles.length + validPdfs.length > 5) {
      alert("Máximo 5 archivos PDF permitidos.");
      return;
    }

    setPdfFiles((prev) => [...prev, ...validPdfs]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePdf = (indexToRemove: number) => {
    setPdfFiles((prev) => prev.filter((_, index) => index !== indexToRemove));
  };

  // ---------- Grabación ----------
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setTranscription("");
        setTopicAnalysis("");
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => setRecordingTime((prev) => prev + 1), 1000);
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
    setTopicAnalysis("");
    setCustomPrompt("");
    setRecordingTime(0);
  };

  // ---------- Transcripción (servidor) ----------
  const transcribeAudio = async () => {
    if (!audioBlob) return;
    setIsProcessing(true);
    setProcessStatus("Transcribiendo...");
    setTranscription("");

    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");

      const response = await fetch("/api/transcribe", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Error en la transcripción");

      setTranscription(data.text || "No se detectó voz.");
      setProcessStatus("");
    } catch (err) {
      console.error(err);
      setTranscription(`❌ Error: ${err instanceof Error ? err.message : "Fallo al transcribir"}`);
      setProcessStatus("");
    } finally {
      setIsProcessing(false);
    }
  };

  // ---------- Análisis (servidor) ----------
  const analyzeWithAI = async () => {
    if (!transcription && pdfFiles.length === 0) {
      alert("Debes grabar audio o subir al menos un PDF para analizar.");
      return;
    }
    if (!customPrompt.trim()) {
      alert("Escribe qué quieres analizar en el campo de texto.");
      return;
    }

    setIsProcessing(true);
    setProcessStatus("La IA está razonando la respuesta...");
    setTopicAnalysis("");

    try {
      const formData = new FormData();
      formData.append("prompt", customPrompt.trim());
      formData.append("transcription", transcription);
      pdfFiles.forEach((f) => formData.append("pdfs", f));

      const response = await fetch("/api/analyze", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Error al analizar");

      setTopicAnalysis(data.analysis);
      setProcessStatus("");
    } catch (err) {
      console.error(err);
      setTopicAnalysis(`❌ Error: ${err instanceof Error ? err.message : "Fallo de conexión."}`);
      setProcessStatus("");
    } finally {
      setIsProcessing(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    alert(`${label} copiado al portapapeles`);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 font-sans dark:bg-black sm:px-6">
      <main className="w-full max-w-2xl space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50 sm:text-4xl">
            Transcriptor Profesional + IA
          </h1>
          <p className="text-base text-zinc-600 dark:text-zinc-400">
            Audio, PDFs y Razonamiento de alta potencia.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-8">
          <div className="space-y-6">
            {/* 1. GRABAR AUDIO */}
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">1. Grabar audio (Opcional)</h2>
                {isRecording && (
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500"></span>
                    </span>
                    <span className="font-mono text-sm font-medium text-red-600 dark:text-red-400">{formatTime(recordingTime)}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                {!isRecording ? (
                  <button onClick={startRecording} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-3 text-sm font-semibold text-white hover:bg-red-700 transition-colors">
                    Iniciar grabación
                  </button>
                ) : (
                  <button onClick={stopRecording} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 transition-colors">
                    Detener
                  </button>
                )}
                {audioBlob && !isRecording && (
                  <button onClick={resetRecording} className="flex items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 transition-colors">
                    Descartar
                  </button>
                )}
              </div>
            </div>

            {audioUrl && !isRecording && (
              <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Audio grabado</h3>
                  <span className="text-xs text-zinc-500">{formatTime(recordingTime)}</span>
                </div>
                <audio src={audioUrl} controls className="w-full" controlsList="nodownload" />
              </div>
            )}

            {/* 2. SUBIR PDFs */}
            <div>
              <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">2. Documentos de referencia (Máx. 5 PDFs)</h2>
              <div className="flex flex-col gap-3">
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  className="block w-full text-sm text-zinc-500 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-4 file:py-2.5 file:text-sm file:font-semibold file:text-white hover:file:bg-indigo-700 cursor-pointer"
                />

                {pdfFiles.length > 0 && (
                  <ul className="space-y-2">
                    {pdfFiles.map((file, index) => (
                      <li key={index} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
                        <div className="flex items-center gap-2 truncate">
                          <span className="text-red-500">📄</span>
                          <span className="truncate text-zinc-700 dark:text-zinc-300">{file.name}</span>
                          <span className="text-xs text-zinc-400">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                        </div>
                        <button onClick={() => removePdf(index)} className="ml-2 rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="Eliminar archivo">
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* 3. TRANSCRIBIR */}
            {audioBlob && !isRecording && !isProcessing && !transcription && (
              <button onClick={transcribeAudio} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                ⚡ 3. Transcribir audio
              </button>
            )}

            {isProcessing && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
                <div className="flex items-center gap-3">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent"></div>
                  <p className="text-sm font-medium text-indigo-900 dark:text-indigo-200">{processStatus}</p>
                </div>
              </div>
            )}

            {transcription && (
              <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/30">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-green-900 dark:text-green-200">4. Transcripción</h3>
                  <button onClick={() => copyToClipboard(transcription, "Transcripción")} className="text-xs font-medium text-green-700 underline hover:text-green-900 dark:text-green-300">Copiar</button>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-green-900 dark:text-green-100">{transcription}</p>
              </div>
            )}

            {/* 4. ANALIZAR CON IA */}
            {(transcription || pdfFiles.length > 0) && !isProcessing && (
              <div className="space-y-3 rounded-lg border border-purple-200 bg-purple-50 p-4 dark:border-purple-900 dark:bg-purple-950/30">
                <h3 className="text-sm font-semibold text-purple-900 dark:text-purple-200">5. ¿Qué quieres analizar?</h3>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Ej: Resume los puntos clave de la clase y crea 5 preguntas de repaso."
                  className="w-full rounded-lg border border-purple-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:border-purple-700 dark:bg-zinc-900 dark:text-zinc-100"
                  rows={3}
                />
                <button
                  onClick={analyzeWithAI}
                  disabled={!customPrompt.trim() || isProcessing}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-4 py-3 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                >
                  🧠 Analizar con IA
                </button>
              </div>
            )}

            {topicAnalysis && (
              <div className="space-y-3 rounded-lg border border-purple-200 bg-gradient-to-br from-purple-50 to-indigo-50 p-5 dark:border-purple-900 dark:from-purple-950/30 dark:to-indigo-950/30">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-purple-900 dark:text-purple-200">✅ Resultado</h3>
                  <button onClick={() => copyToClipboard(topicAnalysis, "Análisis")} className="text-xs font-medium text-purple-700 underline hover:text-purple-900 dark:text-purple-300">Copiar</button>
                </div>
                <p className="whitespace-pre-wrap text-base font-medium leading-relaxed text-purple-950 dark:text-purple-100">{topicAnalysis}</p>
                <button onClick={() => setTopicAnalysis("")} className="text-xs font-medium text-purple-700 underline hover:text-purple-900 dark:text-purple-300">Hacer otra pregunta</button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}