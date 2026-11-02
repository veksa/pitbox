// The private interfaces the fold helper calls: SpringBoard's display tool service takes a settings struct (the
// layout follows its method signature, {?=qdqqBqdd}), and IOKit builds the vendor-defined HID events that carry
// the hinge angle and the device orientation.
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <stdint.h>

/// Swapping the lit screen at once.
typedef struct {
  int64_t unused;
  double duration;
  int64_t deviceOrientation;
  int64_t profileOverride;
  bool waitForCompletion;
  int64_t targetMode;
  double targetHingePosition;
  double unused2;
} PitboxSwapSettings;

/// An IOHIDEvent of a vendor-defined usage, carrying `data` as it is.
CF_RETURNS_RETAINED CFTypeRef _Nullable IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef _Nullable allocator, uint64_t timestamp, uint32_t usagePage, uint32_t usage, uint32_t version, const uint8_t *_Nonnull data, CFIndex length, uint32_t options);
