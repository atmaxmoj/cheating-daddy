// call-state.swift — tells the app whether a call is running on this Mac, so the assistant can say
// "Listening: phone call" instead of "Listening: computer audio".
//
// An iPhone call answered on the Mac (Continuity) and a FaceTime call both run their audio through
// the system's call daemons: avconferenced (call media) and callservicesd (TelephonyUtilities).
// Core Audio lists every process doing audio I/O (macOS 14.2+); a call is on while either daemon
// runs input or output. Prints "phone" or "computer" once at start and on every change.
//
// Build: swiftc -O native/call-state.swift -o src/assets/CallState

import CoreAudio
import Foundation

let callDaemons: Set<String> = ["com.apple.avconferenced", "com.apple.TelephonyUtilities"]

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processObjects() -> [AudioObjectID] {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func flag(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
    var addr = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr && value != 0
}

func bundleID(_ id: AudioObjectID) -> String {
    var addr = address(kAudioProcessPropertyBundleID)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let s = value else { return "" }
    return s.takeRetainedValue() as String
}

func callIsOn() -> Bool {
    processObjects().contains { id in
        callDaemons.contains(bundleID(id))
            && (flag(id, kAudioProcessPropertyIsRunningInput) || flag(id, kAudioProcessPropertyIsRunningOutput))
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
var last = ""
// ponytail: polls once a second; a property listener per process is the upgrade if a second's lag matters.
while true {
    let now = callIsOn() ? "phone" : "computer"
    if now != last {
        print(now)
        last = now
    }
    Thread.sleep(forTimeInterval: 1)
}
