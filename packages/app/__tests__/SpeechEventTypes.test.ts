import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/hooks/useSpeechRecognition.ts'),
  'utf-8',
)

describe('useSpeechRecognition typed event handlers (#1912)', () => {
  test('result event handler uses ExpoSpeechRecognitionResultEvent type', () => {
    expect(src).toMatch(/useSpeechEvent\('result',\s*\(event:\s*ExpoSpeechRecognitionResultEvent\)/)
  })

  test('error event handler uses ExpoSpeechRecognitionErrorEvent type', () => {
    expect(src).toMatch(/useSpeechEvent\('error',\s*\(event:\s*ExpoSpeechRecognitionErrorEvent\)/)
  })

  test('no untyped any remains in event handlers', () => {
    // Match event: any pattern — should not exist
    expect(src).not.toMatch(/\(event:\s*any\)/)
  })

  test('imports the event types from expo-speech-recognition', () => {
    // Tolerate additional type imports (e.g. ExpoSpeechRecognitionOptions
    // added by #4827) AND any ordering of the imported names — lookaheads
    // assert both event types appear inside the same import block without
    // pinning their position relative to each other.
    expect(src).toMatch(
      /import type \{(?=[^}]*\bExpoSpeechRecognitionResultEvent\b)(?=[^}]*\bExpoSpeechRecognitionErrorEvent\b)[^}]*\} from 'expo-speech-recognition'/,
    )
  })
})
