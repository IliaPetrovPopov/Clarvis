import AppKit
import CoreGraphics
import Foundation

/*
 The dock icon, drawn rather than stored.

 A binary asset in a repository is a thing nobody can review and everybody is
 afraid to change. This is the same motif the dashboard uses - the reticle: an
 outcome ring around a pipeline ring - so the icon says what the application is
 rather than decorating it, and changing it is a code change like any other.

 Written at build time into every size macOS asks for.
 */

let sizes = [16, 32, 64, 128, 256, 512, 1024]
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./icon.iconset"

try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

/// Colours lifted from the dashboard, so the icon and the window agree.
let ink = CGColor(red: 0.027, green: 0.031, blue: 0.039, alpha: 1)
let signal = CGColor(red: 0.243, green: 0.878, blue: 0.941, alpha: 1)
let good = CGColor(red: 0.220, green: 0.878, blue: 0.647, alpha: 1)
let attend = CGColor(red: 0.941, green: 0.678, blue: 0.290, alpha: 1)
let track = CGColor(red: 0.106, green: 0.125, blue: 0.157, alpha: 1)

func arc(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, r: CGFloat, from: CGFloat, to: CGFloat,
         width: CGFloat, color: CGColor) {
    ctx.setStrokeColor(color)
    ctx.setLineWidth(width)
    ctx.setLineCap(.butt)
    // Zero at twelve o'clock, clockwise, matching the dashboard's reticle.
    let start = -CGFloat.pi / 2 + from * 2 * .pi
    let end = -CGFloat.pi / 2 + to * 2 * .pi
    ctx.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: start, endAngle: end, clockwise: false)
    ctx.strokePath()
}

func draw(size: Int) -> CGImage? {
    let s = CGFloat(size)
    guard let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    // macOS rounds and shadows the icon itself on recent systems; a squircle
    // drawn here would be rounded twice.
    let inset = s * 0.09
    let rect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = rect.width * 0.22

    ctx.setFillColor(ink)
    ctx.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
    ctx.fillPath()

    let cx = s / 2, cy = s / 2
    let outer = s * 0.29
    let inner = s * 0.185
    let outerWidth = s * 0.075
    let innerWidth = s * 0.028

    // Outer: the outcome ring, mostly green with a slice of attention - a
    // healthy run, which is what the tool is for.
    arc(ctx, cx: cx, cy: cy, r: outer, from: 0, to: 1, width: outerWidth, color: track)
    arc(ctx, cx: cx, cy: cy, r: outer, from: 0, to: 0.78, width: outerWidth, color: good)
    arc(ctx, cx: cx, cy: cy, r: outer, from: 0.78, to: 0.93, width: outerWidth, color: attend)

    // Inner: the pipeline, part way through.
    arc(ctx, cx: cx, cy: cy, r: inner, from: 0, to: 1, width: innerWidth, color: track)
    arc(ctx, cx: cx, cy: cy, r: inner, from: 0, to: 0.62, width: innerWidth, color: signal)

    // The centre pip. At the smallest sizes the rings merge into a blur, and
    // this is what still reads at 16 points in a menu bar.
    ctx.setFillColor(signal)
    ctx.fillEllipse(in: CGRect(x: cx - s * 0.045, y: cy - s * 0.045, width: s * 0.09, height: s * 0.09))

    return ctx.makeImage()
}

for size in sizes {
    for (suffix, pixels) in [("", size), ("@2x", size * 2)] {
        guard pixels <= 1024, let image = draw(size: pixels) else { continue }
        let name = "\(out)/icon_\(size)x\(size)\(suffix).png"
        guard let dest = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: name) as CFURL, "public.png" as CFString, 1, nil
        ) else { continue }
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)
    }
}

print("wrote \(out)")
