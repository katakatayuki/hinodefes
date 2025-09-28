// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore, serverTimestamp } from "firebase/firestore"; 
import { getAuth, signInAnonymously } from "firebase/auth"; 

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCb6SokAWNHqDKoBK34_QVko9WoOswMGHg",
  authDomain: "hinodefes-57609.firebaseapp.com",
  projectId: "hinodefes-57609",
  storageBucket: "hinodefes-57609.firebasestorage.app",
  messagingSenderId: "946334233570",
  appId: "1:946334233570:web:5c7afa58394ecc55adffbb",
  measurementId: "G-W34ZJJKZ04"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);
const auth = getAuth();
signInAnonymously(auth).catch(() => { /* kiosk用: handle if you prefer custom auth */ });

// ここで、db, auth, serverTimestamp をエクスポートする
export { db, auth, serverTimestamp };
