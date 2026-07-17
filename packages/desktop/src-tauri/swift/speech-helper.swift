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

// Set to true by setDone() to break out of the main RunLoop. setDone() is
// called from teardown() (the normal stop path) AND from early error paths
// in startRecognition() — permission denied, recognizer unavailable, or
// audio-engine start failure — so the helper exits promptly in all cases.
var done = false
let doneLock = NSLock()

func setDone() {
    doneLock.lock()
    done = true
    doneLock.unlock()
    // Wake the main RunLoop so its current `run(mode:before:)` returns promptly.
    CFRunLoopStop(CFRunLoopGetMain())
}

func isDone() -> Bool {
    doneLock.lock()
    defer { doneLock.unlock() }
    return done
}

func startRecognition() {
    requestAuthorization { granted in
        guard granted else {
            printJSON(["error": "Speech recognition permission denied"])
            setDone()
            return
        }

        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            printJSON(["error": "Speech recognizer not available"])
            setDone()
            return
        }

        let audioEngine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        // Note: do NOT set requiresOnDeviceRecognition = true unconditionally.
        // When on-device assets are not downloaded for the user's locale, the
        // recognition task hangs silently (no result, no error). Letting Speech
        // pick its source — on-device if assets are ready, network otherwise —
        // is reliably responsive across configurations.

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
            setDone()
            return
        }

        // Guard against concurrent teardown from recognition callback and stdin reader.
        // Only the first caller to acquire the lock with `tornDown == false` performs teardown.
        let teardownLock = NSLock()
        var tornDown = false

        func teardown(stopEngine: Bool) {
            teardownLock.lock()
            let alreadyDone = tornDown
            if !alreadyDone { tornDown = true }
            teardownLock.unlock()

            guard !alreadyDone else { return }

            if stopEngine {
                audioEngine.stop()
                inputNode.removeTap(onBus: 0)
            }
            setDone()
        }

        // Benign recognizer error codes that must NOT surface as a red banner:
        //   216  = recognition canceled (normal stop via stdin "stop")
        //   301  = "Recognition request was canceled" — the code the cancellation
        //          path (task.cancel()) actually reports on current macOS. The old
        //          216-only check leaked this as an error banner on every clean
        //          push-to-talk release / Command press (#6634).
        //   1110 = no speech detected (a benign silent push-to-talk hold, #6636)
        let benignErrorCodes: Set<Int> = [216, 301, 1110]
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let error = error as NSError? {
                if !benignErrorCodes.contains(error.code) {
                    printJSON(["error": error.localizedDescription])
                }
                teardown(stopEngine: true)
                return
            }

            if let result = result {
                printJSON([
                    "text": result.bestTranscription.formattedString,
                    "is_final": result.isFinal
                ])

                if result.isFinal {
                    teardown(stopEngine: true)
                }
            }
        }

        // Read stdin for "stop" command
        DispatchQueue.global().async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespaces) == "stop" {
                    request.endAudio()
                    task.cancel()
                    // task.cancel() triggers the recognition callback with error 216,
                    // which will call teardown(stopEngine: true). We call teardown here
                    // as well so that if the callback fires first we don't double-stop,
                    // and if this path wins we still perform a clean shutdown.
                    teardown(stopEngine: true)
                    break
                }
            }
        }
    }

    // Apple's SFSpeechRecognizer.recognitionTask(with:resultHandler:) invokes
    // its result handler on the MAIN THREAD. If we block the main thread on a
    // semaphore (or anything else that doesn't service the runloop), the
    // handler never fires and recognition is silent forever.
    //
    // Run the main RunLoop instead — it processes both dispatch queue work
    // (the async authorization completion above) AND Apple framework callbacks
    // (the recognition result handler). teardown() calls CFRunLoopStop, which
    // returns control here so the function (and process) can exit cleanly.
    //
    // Explicitly drive RunLoop.main (not RunLoop.current) so the loop being
    // driven here always matches the one setDone() stops via
    // CFRunLoopStop(CFRunLoopGetMain()), regardless of which thread invokes
    // startRecognition() in the future.
    while !isDone() {
        RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 1.0))
    }
}

// Main
let args = CommandLine.arguments
if args.count > 1 && args[1] == "check" {
    checkAvailability()
} else {
    startRecognition()
}
