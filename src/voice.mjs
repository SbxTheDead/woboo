// Voice input and output.
//
// Input: Whisper API (OpenAI-compatible) converts speech to text. The Telegram
// bot already forwards voice messages as audio files — this transcribes them
// so the owner can talk to Woboo from their phone.
//
// Output: Text-to-speech converts mission reports to audio. Useful for the
// desktop widget — Woboo can speak its results instead of just showing them.

import fs from 'node:fs';
import path from 'node:path';
import { loadSecrets, loadSettings } from './config.mjs';
import { record } from './journal.mjs';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const TTS_URL = 'https://api.openai.com/v1/audio/speech';

// Transcribe audio to text using Whisper.
export async function transcribe(audioPath) {
  const key = loadSecrets().openaiApiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    record('voice', 'no OpenAI key for transcription', { level: 'warn' });
    return null;
  }

  try {
    const form = new FormData();
    const buffer = fs.readFileSync(audioPath);
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    form.append('file', blob, path.basename(audioPath));
    form.append('model', 'whisper-1');

    const resp = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key },
      body: form,
    });

    if (!resp.ok) {
      record('voice', 'transcription failed: ' + resp.status, { level: 'error' });
      return null;
    }

    const data = await resp.json();
    record('voice', 'transcribed: ' + (data.text || '').slice(0, 80), { level: 'ok' });
    return data.text || null;
  } catch (err) {
    record('voice', 'transcription error: ' + err.message, { level: 'error' });
    return null;
  }
}

// Convert text to speech audio.
export async function speak(text, outputPath) {
  const key = loadSecrets().openaiApiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    record('voice', 'no OpenAI key for TTS', { level: 'warn' });
    return null;
  }

  try {
    const resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text.slice(0, 4096), // API limit
        voice: loadSettings().ttsVoice || 'alloy',
        response_format: 'mp3',
      }),
    });

    if (!resp.ok) {
      record('voice', 'TTS failed: ' + resp.status, { level: 'error' });
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    record('voice', 'spoken: ' + text.slice(0, 60), { level: 'ok' });
    return outputPath;
  } catch (err) {
    record('voice', 'TTS error: ' + err.message, { level: 'error' });
    return null;
  }
}
