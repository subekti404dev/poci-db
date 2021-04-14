import axios from "axios";
const TIMEOUT_INTERNET_CHECK = 5; // seconds

class InternetUtils {
 public async isOnline(url) {
  return new Promise((resolve, reject) => {
   const timer = setTimeout(() => {
    reject(new Error("No internet connection"));
   }, TIMEOUT_INTERNET_CHECK * 1000);
   axios
    .request({
     url,
     method: "HEAD",
    })
    .then(() => {
     clearTimeout(timer);
     resolve(true);
    })
    .catch(() => {
     clearTimeout(timer);
     console.log("No internet connection");
     resolve(false);
    });
  });
 }
}

export default new InternetUtils();
