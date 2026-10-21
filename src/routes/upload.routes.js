import express from 'express';
import multer from 'multer';
import cloudinary from '../config/cloudinary.js';
import verifyToken from '../middleware/verifyToken.js';
import asyncHandler from '../middleware/asyncHandler.js';

const router = express.Router();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// POST /api/upload/profile-picture
router.post('/profile-picture', verifyToken, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  try {
    // Convert buffer to base64 for Cloudinary
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'swift-ship/profiles',
      public_id: `${req.user.uid}_profile`,
      transformation: [
        { width: 500, height: 500, crop: 'limit' },
        { quality: 'auto' },
      ],
    });

    res.status(200).json({
      url: result.secure_url,
      public_id: result.public_id,
    });
  } catch {
    res.status(500).json({ error: 'Failed to upload image to Cloudinary' });
  }
}));

// POST /api/upload/document - rider document uploads (NID, license, bike registration)
router.post('/document', verifyToken, upload.single('image'), asyncHandler(async (req, res) => {
  const { documentType } = req.body;

  const validTypes = ['nid', 'license', 'bikeRegistration'];
  if (!documentType || !validTypes.includes(documentType)) {
    return res.status(400).json({ error: 'Invalid document type. Must be nid, license, or bikeRegistration.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No document file provided' });
  }

  try {
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: `swift-ship/documents/${documentType}`,
      public_id: `${req.user.uid}_${documentType}`,
      transformation: [
        { width: 1200, height: 1200, crop: 'limit' },
        { quality: 'auto' },
      ],
    });

    res.status(200).json({
      url: result.secure_url,
      public_id: result.public_id,
      documentType,
    });
  } catch {
    res.status(500).json({ error: 'Failed to upload document to Cloudinary' });
  }
}));

export default router;