// pitbox's Mac audio helper: which processes record from an input device right now, read from Core Audio's process
// objects (macOS 14 and later). `audio recorders` prints one line per recording process:
//   <pid>\t<bundle id or ->\t<uid of each input device it runs on, comma-separated>
// It never changes a device or a setting; it only reads.

import CoreAudio
import Foundation

func prop(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func objects(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
  var addr = prop(selector, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func u32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var addr = prop(selector)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func i32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int32? {
  var addr = prop(selector)
  var value: Int32 = 0
  var size = UInt32(MemoryLayout<Int32>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = prop(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
  return v.takeRetainedValue() as String
}

func recorders() {
  if #available(macOS 14.0, *) {
    for p in objects(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList) {
      guard u32(p, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
      let pid = i32(p, kAudioProcessPropertyPID) ?? -1
      let bundle = string(p, kAudioProcessPropertyBundleID).flatMap { $0.isEmpty ? nil : $0 } ?? "-"
      let devices = objects(p, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput).compactMap { string($0, kAudioDevicePropertyDeviceUID) }
      print("\(pid)\t\(bundle)\t\(devices.joined(separator: ","))")
    }
  } else {
    FileHandle.standardError.write("audio recorders needs macOS 14 or later\n".data(using: .utf8)!)
    exit(2)
  }
}

switch CommandLine.arguments.dropFirst().first {
case "recorders": recorders()
default:
  FileHandle.standardError.write("usage: audio recorders\n".data(using: .utf8)!)
  exit(64)
}
