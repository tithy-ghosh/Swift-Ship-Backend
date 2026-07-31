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
  console.log('📸 Upload request received');
  console.log('User from token:', req.user);
  console.log('File received:', req.file?.originalname);
  console.log('File size:', req.file?.size);
  console.log('File mimetype:', req.file?.mimetype);
  
  if (!req.file) {
    console.error('❌ No file in request');
    return res.status(400).json({ error: 'No image file provided' });
  }

  try {
    // Convert buffer to base64 for Cloudinary
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    console.log('Uploading to Cloudinary...');
    
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'swift-ship/profiles',
      public_id: `${req.user.uid}_profile`,
      transformation: [
        { width: 500, height: 500, crop: 'limit' },
        { quality: 'auto' },
      ],
    });

    console.log('✅ Cloudinary upload successful');
    console.log('Image URL:', result.secure_url);

    res.status(200).json({
      url: result.secure_url,
      public_id: result.public_id,
    });
  } catch (error) {
    console.error('❌ Cloudinary upload error:', error.message);
    console.error('Full error:', error);
    res.status(500).json({ error: 'Failed to upload image to Cloudinary' });
  }
}));

export default router;