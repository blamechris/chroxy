/// speech-helper — Streams speech recognition results as JSON lines to stdout.
///
/// Usage:
///   speech-helper start   → begin recording, stream transcriptions
///   speech-helper check   → print {"available": true/false, "authorized": true/false}
///
/// Output (one JSON object per line):
///   {"text": "hello world", "is_final": false}
///   {"text": "hello world how are you", "is_final": true}
///   {"error": "..."}

import Foundation
import Speech
import AVFoundation

// Unbuffered stdout for real-time streaming
setbuf(stdout, nil)

func printJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func checkAvailability() {
    let recognizer = SFSpeechRecognizer()
    let available = recognizer?.isAvailable ?? false
    let status = SFSpeechRecognizer.authorizationStatus()
    printJSON([
        "available": available,
        "authorized": status == .authorized,
        "status": statusString(status)
    ])
}

func statusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "not_determined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .authorized: return "authorized"
    @unknown default: return "unknown"
    }
}

func requestAuthorization(completion: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
        completion(status == .authorized)
    }

    // Also request microphone
    if #available(macOS 14.0, *) {
        AVAudioApplication.requestRecordPermission { granted in
            if !granted {
                printJSON(["error": "Microphone permission denied"])
            }
        }
    } else {
        // On older macOS, mic permission is requested on first use
    }
}

func startRecognition() {
    let semaphore = DispatchSemaphore(value: 0)

    requestAuthorization { granted in
        guard granted else {
            printJSON(["error": "Speech recognition permission denied"])
            semaphore.signal()
            return
        }

        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            printJSON(["error": "Speech recognizer not available"])
            semaphore.signal()
            return
        }

        let audioEngine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        // Prefer on-device recognition for privacy
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            printJSON(["error": "Failed to start audio engine: \(error.localizedDescription)"])
            semaphore.signal()
            return
        }

        let task = recognizer.recognitionTask(with: request) { result, error in
            if let error = error as NSError? {
                // 216 = canceled (normal stop via stdin "stop")
                // 1110 = no speech detected
                if error.code != 216 && error.code != 1110 {
                    printJSON(["error": error.localizedDescription])
                }
                audioEngine.stop()
                inputNode.removeTap(onBus: 0)
                semaphore.signal()
                return
            }

            if let result = result {
                printJSON([
                    "text": result.bestTranscription.formattedString,
                    "is_final": result.isFinal
                ])

                if result.isFinal {
                    audioEngine.stop()
                    inputNode.removeTap(onBus: 0)
                    semaphore.signal()
                }
            }
        }

        // Read stdin for "stop" command
        DispatchQueue.global().async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespaces) == "stop" {
                    request.endAudio()
                    audioEngine.stop()
                    inputNode.removeTap(onBus: 0)
                    task.cancel()
                    semaphore.signal()
                    break
                }
            }
        }

        semaphore.wait()
    }
}

// Main
let args = CommandLine.arguments
if args.count > 1 && args[1] == "check" {
    checkAvailability()
} else {
    startRecognition()
}
