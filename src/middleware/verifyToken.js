import admin from '../config/firebase.js'

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' })
  }

  const token = authHeader.split('Bearer ')[1]

  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.user = decoded // uid, email, etc. now available in all route handlers
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' })
  }
}

export default verifyToken