#!/usr/bin/env python3
"""
Train a sign language MLP model from a dataset of hand images.
Extracts MediaPipe landmarks, trains a simple Keras MLP, and exports
weights as JSON in the format expected by signLanguageClassifier.ts.

Usage:
    python scripts/train-sign-language-model.py \
        --dataset ./asl-images \
        --locale asl \
        --output client-aac/public/models/asl/model.json

Dataset structure:
    dataset/
      A/
        img1.jpg
        img2.jpg
        ...
      B/
        ...

Each subfolder name becomes a class label.

Requirements:
    pip install mediapipe opencv-python tensorflow numpy
"""

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

# Lazy imports for optional deps
def import_mediapipe():
    try:
        import mediapipe as mp
        return mp
    except ImportError:
        print("ERROR: mediapipe is required. Install with: pip install mediapipe")
        sys.exit(1)

def import_tensorflow():
    try:
        import tensorflow as tf
        return tf
    except ImportError:
        print("ERROR: tensorflow is required. Install with: pip install tensorflow")
        sys.exit(1)


def extract_landmarks(image_path: str, hands_detector) -> np.ndarray | None:
    """Extract 21 hand landmarks from an image, return 63-element feature vector or None."""
    img = cv2.imread(str(image_path))
    if img is None:
        return None

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    result = hands_detector.process(rgb)

    if not result.multi_hand_landmarks or len(result.multi_hand_landmarks) == 0:
        return None

    # Use the first detected hand
    hand = result.multi_hand_landmarks[0]
    landmarks = np.array([[lm.x, lm.y, lm.z] for lm in hand.landmark])  # (21, 3)

    # Wrist-relative
    wrist = landmarks[0]
    relative = landmarks - wrist

    # Normalize by max absolute value
    max_abs = np.max(np.abs(relative))
    if max_abs > 1e-8:
        relative = relative / max_abs

    return relative.flatten()  # (63,)


def load_dataset(dataset_dir: str, hands_detector) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Load dataset: extract landmarks from all images in class subfolders."""
    dataset_path = Path(dataset_dir)
    if not dataset_path.is_dir():
        print(f"ERROR: Dataset directory not found: {dataset_dir}")
        sys.exit(1)

    # Collect class labels (sorted for deterministic ordering)
    class_dirs = sorted([d for d in dataset_path.iterdir() if d.is_dir()])
    if len(class_dirs) == 0:
        print(f"ERROR: No class subdirectories found in {dataset_dir}")
        sys.exit(1)

    labels = [d.name for d in class_dirs]
    print(f"Found {len(labels)} classes: {labels}")

    all_features = []
    all_targets = []
    image_extensions = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

    for class_idx, class_dir in enumerate(class_dirs):
        images = [f for f in class_dir.iterdir() if f.suffix.lower() in image_extensions]
        count = 0

        for img_path in images:
            features = extract_landmarks(str(img_path), hands_detector)
            if features is not None:
                all_features.append(features)
                all_targets.append(class_idx)
                count += 1

        print(f"  [{labels[class_idx]}] {count}/{len(images)} images with detected hands")

    if len(all_features) == 0:
        print("ERROR: No landmarks extracted from any image")
        sys.exit(1)

    X = np.array(all_features, dtype=np.float32)
    y = np.array(all_targets, dtype=np.int32)
    print(f"Total samples: {len(X)}")

    return X, y, labels


def train_model(X: np.ndarray, y: np.ndarray, num_classes: int, epochs: int = 50):
    """Train a simple MLP: 63 -> 128 -> 64 -> num_classes."""
    tf = import_tensorflow()

    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(63,)),
        tf.keras.layers.Dense(128, activation="relu"),
        tf.keras.layers.Dense(64, activation="relu"),
        tf.keras.layers.Dense(num_classes, activation="softmax"),
    ])

    model.compile(
        optimizer="adam",
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )

    model.summary()

    # Train with validation split
    model.fit(
        X, y,
        epochs=epochs,
        batch_size=32,
        validation_split=0.2,
        verbose=1,
    )

    return model


def export_model_json(model, labels: list[str], locale: str, output_path: str):
    """Export Keras model weights to our JSON format."""
    layers_data = []

    for layer in model.layers:
        weights = layer.get_weights()
        if len(weights) == 2:  # Dense layer: [kernel, bias]
            kernel, bias = weights
            # kernel shape: (input_size, output_size) -> transpose to (output_size, input_size)
            layers_data.append({
                "weights": kernel.T.tolist(),
                "bias": bias.tolist(),
            })

    model_json = {
        "locale": locale,
        "name": f"{locale.upper()} Sign Language Model",
        "labels": labels,
        "inputSize": 63,
        "layers": layers_data,
    }

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(model_json, f, indent=2)

    file_size = os.path.getsize(output_path)
    print(f"Model exported to {output_path} ({file_size / 1024:.1f} KB)")
    print(f"  Classes: {len(labels)}")
    print(f"  Layers: {len(layers_data)}")


def main():
    parser = argparse.ArgumentParser(description="Train sign language MLP from image dataset")
    parser.add_argument("--dataset", required=True, help="Path to dataset directory")
    parser.add_argument("--locale", required=True, help="Sign language locale (e.g. 'asl', 'isl')")
    parser.add_argument("--output", required=True, help="Output JSON model path")
    parser.add_argument("--epochs", type=int, default=50, help="Training epochs (default: 50)")
    args = parser.parse_args()

    mp = import_mediapipe()

    print("Initializing MediaPipe Hands...")
    hands = mp.solutions.hands.Hands(
        static_image_mode=True,
        max_num_hands=1,
        min_detection_confidence=0.5,
    )

    print(f"Loading dataset from {args.dataset}...")
    X, y, labels = load_dataset(args.dataset, hands)
    hands.close()

    print(f"Training model ({args.epochs} epochs)...")
    model = train_model(X, y, num_classes=len(labels), epochs=args.epochs)

    print("Exporting model...")
    export_model_json(model, labels, args.locale, args.output)
    print("Done!")


if __name__ == "__main__":
    main()
