const pdfParse = require('pdf-parse');

const MAX_EXCERPT_CHARS = 6000;
const TEXT_MIME_TYPES = ['text/plain'];
const PDF_MIME_TYPES = ['application/pdf'];
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function isSupportedMimeType(mimetype) {
  return TEXT_MIME_TYPES.includes(mimetype) || PDF_MIME_TYPES.includes(mimetype) || IMAGE_MIME_TYPES.includes(mimetype);
}

function isImageMimeType(mimetype) {
  return IMAGE_MIME_TYPES.includes(mimetype);
}

// Returns { excerpt } for text/PDF uploads, or { image: { base64, mimeType } }
// for image uploads (sent to a vision-capable model instead of extracted).
// Throws a clean, user-facing error if the file can't be read - never lets
// a parse failure crash the request.
async function processDocument(file) {
  if (isImageMimeType(file.mimetype)) {
    return { image: { base64: file.buffer.toString('base64'), mimeType: file.mimetype } };
  }

  if (TEXT_MIME_TYPES.includes(file.mimetype)) {
    const text = file.buffer.toString('utf8');
    return { excerpt: text.slice(0, MAX_EXCERPT_CHARS) };
  }

  if (PDF_MIME_TYPES.includes(file.mimetype)) {
    try {
      const data = await pdfParse(file.buffer);
      const text = (data.text || '').trim();
      if (!text) {
        const error = new Error("That PDF doesn't seem to have any readable text - try a different file, or paste the details into the notes field instead");
        error.status = 400;
        throw error;
      }
      return { excerpt: text.slice(0, MAX_EXCERPT_CHARS) };
    } catch (err) {
      if (err.status) throw err;
      const error = new Error("Couldn't read that PDF - try a different file, or paste the details into the notes field instead");
      error.status = 400;
      throw error;
    }
  }

  const error = new Error('Unsupported file type - please upload a .txt, .pdf, or image (jpg/png/webp)');
  error.status = 400;
  throw error;
}

const MAX_FILES = 5;

// Runs processDocument over every uploaded file and merges the results:
// text/PDF excerpts are concatenated (each still individually capped at
// MAX_EXCERPT_CHARS, labeled by filename so the model can tell them
// apart), and images are collected into an array for a vision-capable
// model. Throws the same clean, user-facing errors processDocument does -
// one bad file fails the whole upload rather than silently dropping it.
async function processDocuments(files) {
  const excerptParts = [];
  const images = [];

  for (const file of files) {
    const result = await processDocument(file);
    if (result.excerpt) {
      excerptParts.push(`--- ${file.originalname} ---\n${result.excerpt}`);
    } else if (result.image) {
      images.push(result.image);
    }
  }

  return {
    excerpt: excerptParts.length > 0 ? excerptParts.join('\n\n') : null,
    images,
  };
}

module.exports = { processDocument, processDocuments, isSupportedMimeType, MAX_FILES };
