#!/usr/bin/env python3
"""
Ingest resized screenshots into the database.
Creates document entries for the 4 resized screenshots.
"""

import hashlib
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / ".ocr-provenance" / "databases" / "default.db"
RESIZED_DIR = Path("/home/user/datalab/data/images/resized")

def compute_hash(file_path: Path) -> str:
    """Compute SHA-256 hash of file."""
    sha256 = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            sha256.update(chunk)
    return sha256.hexdigest()

def main():
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()

    # Find PNG files in resized directory
    files = list(RESIZED_DIR.glob("*.png"))
    print(f"Found {len(files)} files to ingest")

    for file_path in files:
        doc_id = str(uuid.uuid4())
        file_hash = compute_hash(file_path)
        file_size = file_path.stat().st_size
        now = datetime.now().isoformat()

        # Check if already exists
        cursor.execute("SELECT id FROM documents WHERE file_hash = ?", (file_hash,))
        if cursor.fetchone():
            print(f"  Skipping (already exists): {file_path.name}")
            continue

        # Create provenance entry first (document references it)
        prov_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO provenance (
                id, type, created_at, processed_at, source_type, source_path,
                root_document_id, content_hash, file_hash, processor,
                processor_version, processing_params, parent_ids, chain_depth, chain_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            prov_id,
            'DOCUMENT',
            now,
            now,
            'FILE',
            str(file_path),
            prov_id,  # Root is itself
            file_hash,
            file_hash,
            'ingest',
            '1.0.0',
            '{}',  # processing_params
            '[]',  # parent_ids (empty for root)
            0,
            '["DOCUMENT"]'
        ))

        # Create document entry
        cursor.execute("""
            INSERT INTO documents (
                id, file_path, file_name, file_type, file_size, file_hash,
                status, provenance_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            doc_id,
            str(file_path),
            file_path.name,
            'png',
            file_size,
            file_hash,
            'pending',
            prov_id,
            now
        ))

        print(f"  Ingested: {file_path.name} ({file_size} bytes)")

    conn.commit()

    # Check pending count
    cursor.execute("SELECT COUNT(*) FROM documents WHERE status='pending'")
    pending = cursor.fetchone()[0]
    print(f"\nTotal pending documents: {pending}")

    conn.close()

if __name__ == "__main__":
    main()
