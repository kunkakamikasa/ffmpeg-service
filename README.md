
# FFmpeg Service (Image + Multiple Audio -> Video)

Endpoints:
- `POST /make/story`: concatenate multiple audio segments with a single image into one long MP4
- `POST /make/segments`: export one short MP4 per audio segment (same image)

Environment variables:
- `OUTPUT_DIR` (default `/tmp/output` on Render)
- `PUBLIC_BASE_URL` (set to your Render domain to get absolute video URLs back)

Example request:
```json
{
  "image_url": "https://.../cover.jpg",
  "audio_urls": ["https://.../p1.mp3", "https://.../p2.mp3"],
  "outfile_prefix": "story_20250906",
  "resolution": "1280x720",
  "fps": 30
}
```
