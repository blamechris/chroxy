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
    expect(src).toMatch(
      /import type \{\s*ExpoSpeechRecognitionResultEvent,\s*ExpoSpeechRecognitionErrorEvent,?\s*\} from 'expo-speech-recognition'/,
    )
  })
})
