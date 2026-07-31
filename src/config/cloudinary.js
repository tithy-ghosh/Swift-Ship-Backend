import { v2 as cloudinary } from 'cloudinary';
import { requireEnv } from './env.js';

cloudinary.config({
  cloud_name: requireEnv('CLOUDINARY_CLOUD_NAME'),
  api_key: requireEnv('CLOUDINARY_API_KEY'),
  api_secret: requireEnv('CLOUDINARY_API_SECRET'),
});

export default cloudinary;
