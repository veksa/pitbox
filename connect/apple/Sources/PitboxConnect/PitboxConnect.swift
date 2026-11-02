// The hosts a debug build talks to (`devserver`, `api`, `media`, …), filled by pitbox. pitbox passes them as
// launch arguments and saves them in the app's defaults when it opens the app on a simulator; a connect link
// (`pitbox.<bundle id>://connect?devserver=host:port&api=host:port`, from `pitbox qr`) saves them on any device.
// `devserver` is mirrored into React Native's `RCT_jsLocation`, where its bundle URL provider reads the bundler.
// Release builds compile every call to a no-op.

import Foundation

public enum PitboxConnect {
  static let prefix = "pitbox."
  static let reactNativeKey = "RCT_jsLocation"

  /// `host:port` of a named host, or nil when pitbox has not set it.
  public static func host(_ name: String, defaults: UserDefaults = .standard) -> String? {
    #if DEBUG
    let value = defaults.string(forKey: prefix + name)
    return value?.isEmpty == false ? value : nil
    #else
    return nil
    #endif
  }

  /// A URL for a named host (`http://host:port`), or `fallback` when pitbox has not set it.
  public static func url(_ name: String, scheme: String = "http", fallback: URL? = nil, defaults: UserDefaults = .standard) -> URL? {
    guard let h = host(name, defaults: defaults) else { return fallback }
    return URL(string: "\(scheme)://\(h)") ?? fallback
  }

  /// Every host pitbox set, by name.
  public static func hosts(defaults: UserDefaults = .standard) -> [String: String] {
    #if DEBUG
    var out: [String: String] = [:]
    for (k, v) in defaults.dictionaryRepresentation() where k.hasPrefix(prefix) {
      if let s = v as? String, !s.isEmpty { out[String(k.dropFirst(prefix.count))] = s }
    }
    return out
    #else
    return [:]
    #endif
  }

  /// Whether a URL is a pitbox connect link: scheme `pitbox.…`, host `connect`.
  public static func isConnectLink(_ url: URL) -> Bool {
    (url.scheme?.lowercased().hasPrefix(prefix) ?? false) && url.host?.lowercased() == "connect"
  }

  /// Saves the hosts of a connect link; an empty value forgets a name. Returns false for any other URL, so it
  /// can go first in the app's URL handler. iOS cannot restart an app: the hosts apply from the next launch
  /// (React Native: from the next reload).
  @discardableResult
  public static func handle(_ url: URL, defaults: UserDefaults = .standard) -> Bool {
    #if DEBUG
    guard isConnectLink(url), let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
    for item in items where !item.name.isEmpty {
      if let v = item.value, !v.isEmpty {
        defaults.set(v, forKey: prefix + item.name)
        if item.name == "devserver" { defaults.set(v, forKey: reactNativeKey) }
      } else {
        defaults.removeObject(forKey: prefix + item.name)
        if item.name == "devserver" { defaults.removeObject(forKey: reactNativeKey) }
      }
    }
    return true
    #else
    return false
    #endif
  }
}
