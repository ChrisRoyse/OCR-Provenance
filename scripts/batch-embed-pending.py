#!/usr/bin/env python3
"""
Batch embed chunks that have no embeddings.
Processes in batches of 500 to prevent CUDA OOM.
"""

import json
import sqlite3
import subprocess
import hashlib
import uuid
import struct
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / ".ocr-provenance" / "databases" / "default.db"
EMBEDDING_WORKER = Path(__file__).parent.parent / "python" / "embedding_worker.py"
VEC_EXTENSION = Path(__file__).parent.parent / "node_modules" / "sqlite-vec-linux-x64" / "vec0.so"
BATCH_SIZE = 500
GPU_BATCH_SIZE = 32

def compute_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()

def get_documents_needing_embeddings(conn):
    """Get documents with chunks but no embeddings."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT DISTINCT d.id, d.file_name, d.file_path, d.file_hash
        FROM documents d
        JOIN chunks c ON c.document_id = d.id
        LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE e.id IS NULL
        AND d.status IN ('pending', 'failed')
        ORDER BY (SELECT COUNT(*) FROM chunks WHERE document_id = d.id) ASC
    """)
    return cursor.fetchall()

def get_chunks_without_embeddings(conn, document_id: str):
    """Get chunks that don't have embeddings."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT c.id, c.text, c.page_number, c.page_range,
               c.character_start, c.character_end, c.chunk_index,
               c.provenance_id, c.text_hash
        FROM chunks c
        LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE c.document_id = ?
        AND e.id IS NULL
        ORDER BY c.chunk_index
    """, (document_id,))
    return cursor.fetchall()

def embed_texts(texts: list) -> list:
    """Embed a batch of texts using the Python worker."""
    # Write texts to temp file
    input_data = json.dumps(texts)

    proc = subprocess.run(
        ["python3", str(EMBEDDING_WORKER), "--stdin", "--batch-size", str(GPU_BATCH_SIZE), "--json"],
        input=input_data,
        capture_output=True,
        text=True
    )

    if proc.returncode != 0:
        raise RuntimeError(f"Embedding failed: {proc.stderr}")

    # Parse the last JSON line (output may have logging before it)
    for line in reversed(proc.stdout.strip().split('\n')):
        if line.startswith('{'):
            result = json.loads(line)
            if result.get('success'):
                return result['embeddings']
            else:
                raise RuntimeError(f"Embedding error: {result.get('error')}")

    raise RuntimeError(f"No valid JSON output: {proc.stdout[:500]}")

def get_document_provenance_id(conn, document_id: str) -> str:
    """Get the root provenance ID for a document."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id FROM provenance
        WHERE type = 'DOCUMENT'
        AND source_path LIKE '%' || (SELECT file_name FROM documents WHERE id = ?)
        LIMIT 1
    """, (document_id,))
    row = cursor.fetchone()
    return row[0] if row else document_id

def store_embeddings(conn, document_id: str, file_path: str, file_name: str, file_hash: str,
                     chunks: list, embeddings: list):
    """Store embeddings and provenance in database."""
    cursor = conn.cursor()
    doc_prov_id = get_document_provenance_id(conn, document_id)
    total_chunks = len(chunks)
    now = datetime.now().isoformat()

    for chunk, embedding in zip(chunks, embeddings):
        chunk_id, text, page_number, page_range, char_start, char_end, chunk_index, chunk_prov_id, text_hash = chunk

        embedding_id = str(uuid.uuid4())
        provenance_id = str(uuid.uuid4())
        content_hash = compute_hash(text)

        # Create provenance record
        cursor.execute("""
            INSERT INTO provenance (
                id, type, created_at, processed_at, source_type, source_id,
                root_document_id, location, content_hash, input_hash, file_hash,
                processor, processor_version, processing_params, parent_id,
                parent_ids, chain_depth, chain_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            provenance_id, 'EMBEDDING', now, now, 'EMBEDDING', chunk_prov_id,
            doc_prov_id, json.dumps({
                'chunk_index': chunk_index,
                'character_start': char_start,
                'character_end': char_end,
                'page_number': page_number
            }), content_hash, text_hash, file_hash,
            'nomic-embed-text-v1.5', '1.5.0',
            json.dumps({
                'dimensions': 768,
                'task_type': 'search_document',
                'inference_mode': 'local',
                'device': 'cuda:0',
                'batch_size': GPU_BATCH_SIZE
            }),
            chunk_prov_id, json.dumps([chunk_prov_id]), 3,
            json.dumps(['DOCUMENT', 'OCR_RESULT', 'CHUNK', 'EMBEDDING'])
        ))

        # Create embedding record
        cursor.execute("""
            INSERT INTO embeddings (
                id, chunk_id, image_id, document_id, original_text, original_text_length,
                source_file_path, source_file_name, source_file_hash,
                page_number, page_range, character_start, character_end,
                chunk_index, total_chunks, model_name, model_version,
                task_type, inference_mode, gpu_device, provenance_id,
                content_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            embedding_id, chunk_id, None, document_id, text, len(text),
            file_path, file_name, file_hash,
            page_number, page_range, char_start, char_end,
            chunk_index, total_chunks, 'nomic-embed-text-v1.5', '1.5.0',
            'search_document', 'local', 'cuda:0', provenance_id,
            content_hash, now
        ))

        # Store vector in sqlite-vec virtual table
        # vec0 expects the vector as a binary blob of floats
        vector_blob = struct.pack(f'{len(embedding)}f', *embedding)
        cursor.execute("""
            INSERT INTO vec_embeddings (embedding_id, vector)
            VALUES (?, ?)
        """, (embedding_id, vector_blob))

        # Update chunk status
        cursor.execute("""
            UPDATE chunks SET embedding_status = 'complete' WHERE id = ?
        """, (chunk_id,))

    conn.commit()

def main():
    print(f"Database: {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))

    # Enable extension loading and load sqlite-vec
    conn.enable_load_extension(True)
    conn.load_extension(str(VEC_EXTENSION))
    print(f"Loaded sqlite-vec extension")

    # Get documents needing embeddings
    docs = get_documents_needing_embeddings(conn)
    print(f"Found {len(docs)} documents needing embeddings")

    for doc_id, file_name, file_path, file_hash in docs:
        chunks = get_chunks_without_embeddings(conn, doc_id)
        total_chunks = len(chunks)

        if total_chunks == 0:
            continue

        print(f"\nProcessing: {file_name}")
        print(f"  Chunks to embed: {total_chunks}")

        # Process in batches of 500
        all_embeddings = []
        for i in range(0, total_chunks, BATCH_SIZE):
            batch = chunks[i:i + BATCH_SIZE]
            batch_texts = [c[1] for c in batch]  # c[1] is text

            print(f"  Batch {i//BATCH_SIZE + 1}/{(total_chunks + BATCH_SIZE - 1)//BATCH_SIZE}: {len(batch)} chunks...")

            try:
                embeddings = embed_texts(batch_texts)
                all_embeddings.extend(embeddings)
                print(f"    Done: {len(embeddings)} embeddings")
            except Exception as e:
                print(f"    ERROR: {e}")
                conn.execute("UPDATE documents SET status = 'failed', error_message = ? WHERE id = ?",
                           (str(e), doc_id))
                conn.commit()
                break
        else:
            # All batches succeeded
            print(f"  Storing {len(all_embeddings)} embeddings...")
            store_embeddings(conn, doc_id, file_path, file_name, file_hash, chunks, all_embeddings)

            # Update document status
            conn.execute("UPDATE documents SET status = 'complete', error_message = NULL WHERE id = ?", (doc_id,))
            conn.commit()
            print(f"  Complete!")

    # Final stats
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM embeddings")
    embed_count = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM chunks")
    chunk_count = cursor.fetchone()[0]
    print(f"\nFinal: {embed_count}/{chunk_count} chunks have embeddings")

    conn.close()

if __name__ == "__main__":
    main()
