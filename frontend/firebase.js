// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
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
  appId: "1:946334233570:web:0b7429cc7f9103dbadffbb",
  measurementId: "G-664KBDV4W7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
