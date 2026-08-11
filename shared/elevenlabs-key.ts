// shared/elevenlabs-key.ts
//
// Storage-side sanity check for ElevenLabs API keys. Live keys start with
// "sk_" and the secret is only revealed once, at creation — so the values that
// actually arrive in this field are, in practice: a real key, the 64-hex key
// ID re-copied from the ElevenLabs dashboard, or a stray password/word that a
// browser autofilled into the password-type input. Everything but a real key
// is rejected BEFORE it reaches the database, with a code the client can
// translate (errors.<CODE>) into an explanation of what was actually pasted.

export type ElevenLabsKeyProblem = "ELEVENLABS_KEY_ID" | "ELEVENLABS_KEY_FORMAT";

export function elevenLabsKeyProblem(value: string): ElevenLabsKeyProblem | null {
  const v = value.trim();
  if (v === "") return null; // clearing the key is always allowed
  if (/^[0-9a-f]{64}$/i.test(v)) return "ELEVENLABS_KEY_ID";
  if (!/^sk_[A-Za-z0-9]{16,}$/.test(v)) return "ELEVENLABS_KEY_FORMAT";
  return null;
}
