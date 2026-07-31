import admin from '../config/firebase.js'

const verifyToken = async (req, res, next) => {
  // 🔍 DEBUG: Print all headers to see what the backend is actually receiving
  console.log(' [verifyToken] ALL HEADERS RECEIVED:', JSON.stringify(req.headers, null, 2));
  
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    console.error('❌ [verifyToken] Authorization header is missing or invalid:', authHeader);
    return res.status(401).json({ error: 'Unauthorized: No token provided' })
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' })
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.user = decoded
    return next()
  } catch (error) {
    console.warn('Firebase token verification failed:', error.code || error.message)
    return res.status(401).json({ error: 'Unauthorized: Invalid token' })
  }
}

export default verifyToken