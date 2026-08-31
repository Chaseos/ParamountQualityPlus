import AppKit
import Foundation

guard CommandLine.arguments.count == 3, let image = NSImage(contentsOfFile: CommandLine.arguments[1]) else {
    fatalError("Usage: swift generate-apple-icons.swift source.png AppIcon.appiconset")
}
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
var entries: [[String: String]] = []
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = NSSize(width: pixels, height: pixels)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        let name = "mac-icon-\(size)@\(scale)x.png"
        try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
        entries.append(["filename":name,"idiom":"mac","scale":"\(scale)x","size":"\(size)x\(size)"])
    }
}
let manifest: [String:Any] = ["images":entries,"info":["author":"xcode","version":1]]
try JSONSerialization.data(withJSONObject: manifest, options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("Contents.json"))
