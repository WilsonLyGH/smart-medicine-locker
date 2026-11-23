/**
 * Firebase Configuration Template — Smart Medicine Locker SCADA/DCS
 *
 * Instructions for Production / Local Firebase Deployment:
 *   1. Copy this file to `public/js/firebase-config.js`.
 *   2. Replace the placeholder values below with your Firebase Web App credentials.
 *   3. If `public/js/firebase-config.js` is absent or still contains placeholder values
 *      (such as on GitHub Pages) or if the URL contains `?demo=true`, the Web HMI
 *      automatically runs in 100% client-side Interactive Demo Mode.
 */
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.YOUR_REGION.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
