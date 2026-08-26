// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const validateNumber = (val: any) => {
  if (Number.isNaN(Number(val)) || val.toString() === "") {
    return "Please enter a valid number.";
  }
  if (val === 0) {
    return "Please enter a number larger than 0";
  }
};
