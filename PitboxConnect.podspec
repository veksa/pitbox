# The Swift connect library (connect/apple) for CocoaPods, shipped in the npm package. A React Native app adds it
# to its Podfile when it wants named hosts or the connect link on a device; simulators need no library at all:
#   pod 'PitboxConnect', :path => '../node_modules/@veksa/pitbox', :configurations => ['Debug']
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'PitboxConnect'
  s.version = package['version']
  s.summary = 'Named hosts and the connect link for debug builds driven by pitbox'
  s.homepage = package['homepage']
  s.license = {type: package['license'], file: 'LICENSE'}
  s.author = package['author']
  s.source = {git: package['repository']['url'].delete_prefix('git+'), tag: s.version.to_s}
  s.swift_version = '5.9'
  s.ios.deployment_target = '15.0'
  s.tvos.deployment_target = '15.0'
  s.visionos.deployment_target = '1.0'
  s.osx.deployment_target = '12.0'
  s.source_files = 'connect/apple/Sources/PitboxConnect/**/*.swift'
end
