import { Client, TravelMode } from "@googlemaps/google-maps-services-js";

const client = new Client({});

export async function getDistance(origin: string, destination: string, mode: TravelMode = TravelMode.driving) {
  const key = process.env["GOOGLE_MAPS_KEY"];
  if (!key) throw new Error("Missing OpenAI API key");
  const resp = await client.distancematrix({
    params: {
      origins: [origin],          // can be "New York, NY" or "40.7128,-74.0060"
      destinations: [destination],
      mode: TravelMode.driving,
      key,
    },
  });

  const element = resp.data.rows[0].elements[0];
  if (element.status !== "OK") throw new Error(element.status);

  return {
    distanceText: element.distance.text,   // e.g. "5.6 km"
    distanceMeters: element.distance.value, 
    durationText: element.duration.text,   // e.g. "12 mins"
    durationSeconds: element.duration.value,
  };
}