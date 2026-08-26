// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Button, SpaceBetween } from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

export const NotFound = () => {
  const navigate = useNavigate();

  return (
    <Box textAlign="center" margin={{ top: "xxxl" }} padding={{ top: "xxxl" }}>
      <SpaceBetween size="m" alignItems="center">
        <Box variant="h1" fontSize="heading-xl">
          Page not found
        </Box>
        <Box variant="p" color="text-body-secondary">
          The page you are looking for does not exist.
        </Box>
        <Button variant="primary" onClick={() => navigate("/")}>
          Go to homepage
        </Button>
      </SpaceBetween>
    </Box>
  );
};
