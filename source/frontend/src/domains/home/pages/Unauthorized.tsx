// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Button, SpaceBetween } from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

export const Unauthorized = () => {
  const navigate = useNavigate();

  return (
    <Box textAlign="center" margin={{ top: "xxxl" }} padding={{ top: "xxxl" }}>
      <SpaceBetween size="m" alignItems="center">
        <Box variant="h1" fontSize="heading-xl">
          Access denied
        </Box>
        <Box variant="p" color="text-body-secondary">
          You don't have permission to access this page.
        </Box>
        <Button variant="primary" onClick={() => navigate("/")}>
          Go to homepage
        </Button>
      </SpaceBetween>
    </Box>
  );
};
