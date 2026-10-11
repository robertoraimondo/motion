import sys
from pathlib import Path

import cv2
import numpy as np


def detect_faces(image, detector):
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    return sorted(
        detector.detectMultiScale(gray, 1.1, 8, minSize=(48, 48)),
        key=lambda face: face[2] * face[3],
        reverse=True,
    )


def feathered_overlay(target, source, box):
    x, y, width, height = box
    if width < 2 or height < 2:
        return
    source = cv2.resize(source, (width, height), interpolation=cv2.INTER_LINEAR)
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(target.shape[1], x + width), min(target.shape[0], y + height)
    if x1 >= x2 or y1 >= y2:
        return
    source = source[y1 - y:y2 - y, x1 - x:x2]
    mask = np.zeros(source.shape[:2], dtype=np.uint8)
    center = (source.shape[1] // 2, source.shape[0] // 2)
    axes = (max(1, source.shape[1] // 2 - 4), max(1, source.shape[0] // 2 - 4))
    cv2.ellipse(mask, center, axes, 0, 0, 360, (255.0, 255.0, 255.0, 255.0), -1)
    mask = cv2.GaussianBlur(mask, (0, 0), max(2, min(source.shape[:2]) * 0.12))
    mask = np.where(mask > 12, mask, 0).astype(np.uint8)
    patch = target[y1:y2, x1:x2]
    cloned = cv2.seamlessClone(source, patch, mask, center, cv2.NORMAL_CLONE)
    target[y1:y2, x1:x2] = cloned


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: preserve-reference-faces.py reference-image input-video output-video")
    reference = cv2.imread(sys.argv[1])
    if reference is None:
        raise RuntimeError("Unable to read the reference image.")
    cv2_package = Path(cv2.__file__).resolve().parent
    detector = cv2.CascadeClassifier(str(cv2_package / "data" / "haarcascade_frontalface_default.xml"))
    reference_faces = detect_faces(reference, detector)
    if not reference_faces:
        raise RuntimeError("No faces were detected in the reference image.")

    capture = cv2.VideoCapture(sys.argv[2])
    if not capture.isOpened():
        raise RuntimeError("Unable to open the generated video.")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    writer = cv2.VideoWriter(sys.argv[3], cv2.VideoWriter.fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise RuntimeError("Unable to create the composited video.")

    reference_crops = [reference[y:y + h, x:x + w] for x, y, w, h in reference_faces]
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        generated_faces = detect_faces(frame, detector)
        for crop, face in zip(reference_crops, generated_faces):
            feathered_overlay(frame, crop, face)
        writer.write(frame)
    capture.release()
    writer.release()


if __name__ == "__main__":
    main()
