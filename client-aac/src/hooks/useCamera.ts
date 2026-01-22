import { useContext } from "react";
import { CameraProvider, useCamera as useCameraContext } from "@/components/CameraProvider";

export const useCamera = useCameraContext;
