// JPEG sequence -> H.264 mp4, hardware-encoded through VideoToolbox (AVAssetWriter).
//
// Why this exists: the only ffmpeg on this machine is Playwright's bundled build
// (~/Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac), which ships ONE encoder — libvpx VP8 — and
// ONE muxer — WebM. It cannot produce H.264 or an mp4 container at all. macOS can, natively.
//
// usage: encode-h264 --frames=DIR --out=FILE.mp4 [--fps=60] [--width=W --height=H] [--mbps=45] [--from=N] [--count=N]
//   --width/--height rescale (for the 1080p deliverable); omit to keep the source size.

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

func arg(_ name: String) -> String? {
    for a in CommandLine.arguments where a.hasPrefix("--\(name)=") {
        return String(a.dropFirst(name.count + 3))
    }
    return nil
}
func die(_ m: String) -> Never {
    FileHandle.standardError.write(("encode-h264: " + m + "\n").data(using: .utf8)!)
    exit(1)
}

guard let framesDir = arg("frames"), let outPath = arg("out") else {
    die("usage: --frames=DIR --out=FILE.mp4 [--fps=60] [--width=W --height=H] [--mbps=45]")
}
let fps = Int32(arg("fps") ?? "60") ?? 60
let mbps = Double(arg("mbps") ?? "45") ?? 45

var files = ((try? FileManager.default.contentsOfDirectory(atPath: framesDir)) ?? [])
    .filter { $0.hasSuffix(".jpg") }
    .sorted()
    .map { framesDir + "/" + $0 }
if let from = Int(arg("from") ?? ""), from > 0, from < files.count { files = Array(files.dropFirst(from)) }
if let count = Int(arg("count") ?? ""), count > 0, count < files.count { files = Array(files.prefix(count)) }
if files.isEmpty { die("no .jpg frames in \(framesDir)") }

func decode(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary)
}

guard let first = decode(files[0]) else { die("cannot decode \(files[0])") }
// H.264 wants even dimensions.
let outW = ((Int(arg("width") ?? "") ?? first.width) / 2) * 2
let outH = ((Int(arg("height") ?? "") ?? first.height) / 2) * 2

let outURL = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: outURL)
try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)

let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4) } catch { die("AVAssetWriter: \(error)") }

let input = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: outW,
        AVVideoHeightKey: outH,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: Int(mbps * 1_000_000),
            AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: true,
            AVVideoExpectedSourceFrameRateKey: Int(fps),
        ] as [String: Any],
    ])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: outW,
        kCVPixelBufferHeightKey as String: outH,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
    ])
guard writer.canAdd(input) else { die("writer cannot add video input") }
writer.add(input)
guard writer.startWriting() else { die("startWriting failed: \(writer.error.map(String.init(describing:)) ?? "?")") }
writer.startSession(atSourceTime: .zero)

let rgb = CGColorSpaceCreateDeviceRGB()
let bitmap = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
let rect = CGRect(x: 0, y: 0, width: outW, height: outH)
let t0 = Date()

func append(_ image: CGImage, _ index: Int) {
    while !input.isReadyForMoreMediaData { usleep(500) }
    guard let pool = adaptor.pixelBufferPool else { die("no pixel buffer pool") }
    var out: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let buf = out else {
        die("pixel buffer alloc failed at frame \(index)")
    }
    CVPixelBufferLockBaseAddress(buf, [])
    if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: outW, height: outH,
                           bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
                           space: rgb, bitmapInfo: bitmap) {
        ctx.interpolationQuality = .high
        ctx.draw(image, in: rect)
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    if !adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps)) {
        die("append failed at frame \(index): \(writer.error.map(String.init(describing:)) ?? "?")")
    }
}

// Decode in parallel batches (JPEG decode, not the encoder, is the bottleneck), append in order.
let batch = 8
var i = 0
while i < files.count {
    let n = min(batch, files.count - i)
    var imgs = [CGImage?](repeating: nil, count: n)
    imgs.withUnsafeMutableBufferPointer { bp in
        let base = i
        DispatchQueue.concurrentPerform(iterations: n) { k in bp[k] = decode(files[base + k]) }
    }
    for k in 0..<n {
        guard let img = imgs[k] else { die("cannot decode \(files[i + k])") }
        append(img, i + k)
    }
    i += n
    if i % 240 == 0 { print("  encoded \(i)/\(files.count)") }
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { die("finish failed: \(writer.error.map(String.init(describing:)) ?? "?")") }

let bytes = (try? FileManager.default.attributesOfItem(atPath: outPath)[.size] as? Int) ?? 0
let secs = Date().timeIntervalSince(t0)
print(String(format: "encoded %d frames %dx%d @%d fps -> %@ (%.1f MB, %.1f s, %.0f fps encode)",
             files.count, outW, outH, Int(fps), outPath, Double(bytes ?? 0) / 1e6, secs, Double(files.count) / secs))
