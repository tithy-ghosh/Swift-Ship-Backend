import admin from '../config/firebase.js'

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
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
